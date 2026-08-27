/* ─────────────────────────────────────────────────────────────────
   MUPFond : le fond de carte du produit, en un seul exemplaire.

   Plan IGN vectoriel (Géoplateforme), rendu par MapLibre GL posé dans
   Leaflet par le pont @maplibre/maplibre-gl-leaflet : Leaflet reste le
   moteur, il garde la vue, les panes, les marqueurs et les bulles,
   seul le fond change.

   TOUTE SURFACE QUI PORTE UNE CARTE PASSE PAR ICI : carte, dashboard,
   accueil, pipeline, prospection, statistiques. Le style, l'attribution,
   le plafond de zoom, les deux registres d'extinction, la transposition
   des routes vers le blanc et son facteur vivent dans ce fichier et
   nulle part ailleurs. Une page qui veut s'écarter du réglage commun le
   demande par PARAMÈTRE D'APPEL (plafondZoom, opacite, paleurRoutes) ;
   elle ne recopie rien. Une recopie ferait diverger les réglages au
   premier changement.

   Script classique attaché à window (pas de bundler côté MUP), sur le
   modèle de _mup-nom.js.
   ───────────────────────────────────────────────────────────────── */
(function (global) {
  if (global.MUPFond) return;

  // Le produit vectoriel s'appelle PLAN.IGN, sans « v2 » : le « v2 » était le
  // nom de la couche WMTS raster qu'on a quittée.
  var STYLE = 'https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/gris.json';

  // OpenStreetMap reste cité : le tracé de tournée vient d'OSRM, donc de
  // données OSM, indépendamment du fond.
  var ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    + ' &middot; Plan IGN &middot; &copy; IGN / G&eacute;oplateforme';

  // Les deux bibliothèques du rendu, à leur version, en un seul endroit.
  // maplibre-gl.css N'EST PAS CHARGÉ, et ne doit pas l'être : le pont
  // n'emploie aucun contrôle MapLibre (il force attributionControl:false côté
  // GL et pose son canvas dans le tilePane de Leaflet). Ce sont 10 ko gzip
  // qu'aucune page ne paie.
  var MAPLIBRE_JS = 'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js';
  var PONT_JS = 'https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.4/leaflet-maplibre-gl.js';

  // 19, ET C'EST MESURÉ, PAS SUPPOSÉ. Le pont cale MapLibre sur getZoom() - 1
  // (tuiles vectorielles de 512 px contre 256 px chez Leaflet) et la source
  // PLAN.IGN annonce maxzoom 18 dans sa metadata.json : le dernier niveau de
  // tuiles réellement servi tombe donc au zoom Leaflet 19. Au-delà, MapLibre
  // agrandit la géométrie du z18, ce qui reste net (c'est du vecteur, pas du
  // pixel étiré) mais n'apporte aucun détail de plus. C'est la borne de la
  // source : une page qui annonçait davantage annonçait du vide.
  var PLAFOND_ZOOM = 19;

  // COUCHES ÉTEINTES PAR SOURCE-LAYER. Premier des deux registres d'extinction :
  // celui-ci porte les couches dont le source-layer ne contient rien qu'on veuille
  // garder, et se coupe donc à cette maille. C'est la forme préférable : le style
  // compte 425 couches, leurs identifiants sont des libellés en clair et
  // changeront, le nom de la couche source ne bouge pas.
  //
  // « ocs_lin » ne figure PAS dans cette liste : aucune couche du style gris ne
  // porte ce source-layer (le seul voisin est toponyme_ocs_lin, qui est un
  // toponyme). L'inscrire aurait été un nom qui ne désigne rien.
  var COUCHES_ETEINTES = ['routier_chemin', 'routier_chemin_sup', 'routier_chemin_sou',
    'oro_relief', 'oro_courbe', 'oro_lin', 'oro_ponc',
    'ocs_vegetation_surf', 'ocs_nature_sol_surf'];

  // COUCHES ÉTEINTES PAR IDENTIFIANT. Second registre : celui des source-layers
  // qui mélangent ce qu'on veut éteindre et ce qu'on veut garder, et qu'une coupe
  // à leur maille emporterait d'un bloc.
  //
  // « limite_lin » porte 18 couches. En partent les limites administratives
  // (commune, département, région), les limites d'état, les clôtures, layons et
  // enceintes militaires, les contours de parcs naturels et de parcs marins :
  // 17 traits qui découpent le fond sans rien dire d'une tournée. Reste allumée
  // « limite cote », le liseré qui sépare la terre de la mer entre les zooms 7 et
  // 10, soit exactement la plage où l'on regarde une tournée à l'échelle
  // régionale, sur une côte découpée : sans lui, le littoral se dissout.
  //
  // « toponyme_limite_ponc » porte 5 libellés, et ils nomment tous l'une des trois
  // familles dont le contour vient de s'éteindre : parcs naturels, parcs marins,
  // zones militaires. Aucun ne désigne autre chose, ils partent donc tous les 5 :
  // un nom seul, posé sur un contour effacé, flotterait sans rien désigner.
  //
  // CE REGISTRE EST FRAGILE, et on le sait en l'écrivant : un identifiant de style
  // est un libellé en clair, que l'IGN peut renommer d'une livraison à l'autre
  // sans prévenir, là où un nom de source-layer tient. On l'accepte ici faute de
  // mieux, le source-layer ne permettant pas de séparer ce qu'on éteint de ce
  // qu'on garde. Le prix s'en paie plus bas, au relevé : tout identifiant inscrit
  // qui ne trouve plus sa couche est compté et signalé en console, pour qu'un
  // renommage se voie au lieu de passer pour une extinction réussie.
  var COUCHES_ETEINTES_PAR_ID = [
    'limite admin - limite de commune',
    'limite admin - limite de département bandeau',
    'limite admin - limite de département tiret',
    'limite admin - limite de région bandeau',
    'limite admin - limite de région tiret',
    'limite etat 1', 'limite etat 2',
    'Limite - cloture', 'Limite - layon',
    'Zone Règlementee - Enceinte militaire',
    'limite zone naturelle',
    'limite zone naturelle - Parc naturel 10',
    'limite zone naturelle - Parc naturel 11',
    'limite zone naturelle - Parc naturel 12',
    'limite zone naturelle - Parc naturel 13',
    'limite zone naturelle - Parc naturel 14',
    'limite zone naturelle - Parc marin',
    'toponyme - limite parc ponc 1 et 2',
    'toponyme - limite parc ponc 3 et 4',
    'toponyme - limite parc marin',
    'toponyme - limite militaire ponc 1 et 2',
    'toponyme - limite militaire ponc 3 et 4'];

  // ROUTES ATTÉNUÉES. Le style gris dessine ses routes en gris soutenu (#B4B4B4,
  // #878787, #727272...), qui rivalise avec les points de fiches et le tracé de
  // tournée : on les transpose vers le blanc, canal par canal, sans jamais
  // toucher l'alpha. Le périmètre se prend par source-layer, comme l'extinction :
  // 94 couches, 98 propriétés de couleur au relevé du style. Les toponymes
  // routiers (bornes, numéros, odonymes) restent à pleine force, ce sont eux qui
  // portent la lecture.
  //
  // PALEUR_ROUTES : 0 laisse la couleur d'origine, 1 rend du blanc pur. Un seul
  // chiffre à changer pour rendre les routes plus ou moins présentes, sur toutes
  // les cartes du produit à la fois.
  var PALEUR_ROUTES = 0.6;
  var COUCHES_ROUTIERES = ['routier_route', 'routier_route_sup', 'routier_route_sou',
    'routier_liaison', 'routier_surf'];

  // DEUX FORMES DE VALEUR CIRCULENT DANS CE STYLE, et il faut savoir lire les
  // deux : la chaîne simple ('#RRGGBB' ou 'rgba(r, g, b, a)'), et la fonction de
  // zoom héritée ({stops:[[zoom, couleur], ...]}, parfois avec une clé base).
  // palirCouleur ne connaît que la chaîne et rend null sur ce qu'elle ne sait pas
  // lire, pour que l'appelant compte ces cas plutôt que de les taire.
  function palirCouleur(couleur, facteur) {
    if (typeof couleur !== 'string') return null;
    function versBlanc(canal) { return Math.round(canal + (255 - canal) * facteur); }
    var hexa = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(couleur);
    if (hexa) {
      return '#' + [1, 2, 3].map(function (rang) {
        return ('0' + versBlanc(parseInt(hexa[rang], 16)).toString(16)).slice(-2);
      }).join('').toUpperCase();
    }
    var rgb = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(couleur);
    if (rgb) {
      var canaux = [1, 2, 3].map(function (rang) { return versBlanc(parseFloat(rgb[rang])); }).join(', ');
      // L'alpha repart tel quel, jamais recalculé.
      return rgb[4] === undefined ? 'rgb(' + canaux + ')' : 'rgba(' + canaux + ', ' + rgb[4] + ')';
    }
    return null;
  }

  // Les réglages s'appliquent sur l'événement load : avant lui, getStyle() ne
  // rend pas encore les couches.
  function appliquerReglages(glMap, paleur) {
    glMap.getStyle().layers.forEach(function (couche) {
      if (COUCHES_ETEINTES.indexOf(couche['source-layer']) < 0) return;
      glMap.setLayoutProperty(couche.id, 'visibility', 'none');
    });

    // Extinction par identifiant. getLayer rend undefined sur un nom que le style
    // ne porte pas : c'est là qu'un renommage IGN se détecte, et on le compte au
    // lieu de laisser setLayoutProperty lever.
    var identifiantsOrphelins = 0;
    COUCHES_ETEINTES_PAR_ID.forEach(function (identifiant) {
      if (!glMap.getLayer(identifiant)) { identifiantsOrphelins++; return; }
      glMap.setLayoutProperty(identifiant, 'visibility', 'none');
    });
    if (identifiantsOrphelins) {
      console.warn('Plan IGN : ' + identifiantsOrphelins + ' identifiant(s) de couche à éteindre sur '
        + COUCHES_ETEINTES_PAR_ID.length + ' sans correspondance dans le style, libellé(s) renommé(s) côté IGN.');
    }

    var releve = { chaines: 0, rampes: 0, intactes: 0 };
    glMap.getStyle().layers.forEach(function (couche) {
      if (COUCHES_ROUTIERES.indexOf(couche['source-layer']) < 0) return;
      var peinture = couche.paint || {};
      Object.keys(peinture).forEach(function (propriete) {
        if (propriete.indexOf('color') < 0) return;
        var valeur = peinture[propriete];
        if (typeof valeur === 'string') {
          var pale = palirCouleur(valeur, paleur);
          if (pale === null) { releve.intactes++; return; }
          glMap.setPaintProperty(couche.id, propriete, pale);
          releve.chaines++;
          return;
        }
        if (valeur && typeof valeur === 'object' && Array.isArray(valeur.stops)) {
          // On recopie la rampe au lieu de la muter : l'objet rendu par
          // getStyle() est celui que MapLibre garde, le modifier sur place
          // brouillerait la comparaison faite par setPaintProperty.
          var complete = true;
          var paliers = valeur.stops.map(function (palier) {
            var pale2 = palirCouleur(palier[1], paleur);
            if (pale2 === null) complete = false;
            return [palier[0], pale2 === null ? palier[1] : pale2];
          });
          if (!complete) { releve.intactes++; return; }
          var rampe = { stops: paliers };
          if ('base' in valeur) rampe.base = valeur.base;
          glMap.setPaintProperty(couche.id, propriete, rampe);
          releve.rampes++;
          return;
        }
        // Expression moderne en tableau ou forme inconnue : laissée telle quelle,
        // mais comptée, pour qu'un silence ne passe pas pour un traitement.
        releve.intactes++;
      });
    });
    if (releve.intactes) {
      console.warn('Plan IGN : ' + releve.intactes + ' propriété(s) de couleur routière laissée(s) intacte(s) sur '
        + (releve.chaines + releve.rampes + releve.intactes) + ', forme de valeur non reconnue.');
    }
  }

  // ── CHARGEMENT DES DEUX BIBLIOTHÈQUES ──────────────────────────────────
  // L'ORDRE EST IMPOSÉ : le pont lit les globales L et maplibregl au moment où
  // il s'évalue. Leaflet est attendu de la page (chaque page le charge déjà
  // pour ses marqueurs et ses bulles) ; MapLibre et le pont viennent d'ici.
  //
  // Une seule promesse pour toute la vie de la page : deux appels concurrents
  // (l'accueil qui défile pendant qu'une autre surface pose sa carte) attendent
  // la même, et les balises ne sont injectées qu'une fois.
  var promesseChargement = null;

  function injecter(src) {
    return new Promise(function (resoudre, rejeter) {
      var balise = document.createElement('script');
      balise.src = src;
      balise.onload = resoudre;
      balise.onerror = function () { rejeter(new Error('MUPFond : chargement impossible de ' + src)); };
      document.head.appendChild(balise);
    });
  }

  function charger() {
    if (promesseChargement) return promesseChargement;
    promesseChargement = (function () {
      if (!global.L) {
        return Promise.reject(new Error('MUPFond : Leaflet doit être chargé avant le fond.'));
      }
      if (global.L.maplibreGL) return Promise.resolve();   // déjà en place
      return injecter(MAPLIBRE_JS).then(function () { return injecter(PONT_JS); });
    })();
    return promesseChargement;
  }

  // ── POSE DU FOND ───────────────────────────────────────────────────────
  // Rend une promesse de la couche, résolue quand le style est chargé ET les
  // réglages appliqués : un appelant qui met en scène quelque chose par-dessus
  // (l'accueil et sa démonstration) sait ainsi que le fond est là.
  //
  // options.plafondZoom : défaut 19, la borne de la source.
  // options.opacite     : défaut 1. Le pont n'a pas d'option d'opacité ; elle
  //                       se pose en CSS sur le conteneur de la couche.
  // options.paleurRoutes: défaut 0.6, cf. PALEUR_ROUTES.
  function poser(map, options) {
    options = options || {};
    var plafond = options.plafondZoom || PLAFOND_ZOOM;
    var paleur = (typeof options.paleurRoutes === 'number') ? options.paleurRoutes : PALEUR_ROUTES;

    // LE PLAFOND DE ZOOM SE POSE SUR LA CARTE, PAS SUR LA COUCHE. Leaflet ne lit
    // options.maxZoom que des couches qui appellent _addZoomLimit, et seul
    // GridLayer le fait, dans son beforeAdd. Le pont étend L.Layer, pas
    // GridLayer : un maxZoom posé dans ses options ne serait lu par personne, et
    // la carte, privée de sa seule couche à bornes, remonterait à
    // getMaxZoom() === Infinity.
    //
    // ET IL SE POSE TOUT DE SUITE, avant même de charger les bibliothèques. Le
    // fond raster qu'on quitte bornait la carte dès sa création, en synchrone ;
    // ici MapLibre et le pont viennent du réseau, et entre l'appel et leur
    // arrivée la carte n'a aucune borne. Or getMaxZoom() === Infinity n'est pas
    // une gêne d'affichage, c'est une panne : L.markerClusterGroup lève « Map has
    // no maxZoom specified » dans son onAdd quand la borne n'est pas finie, et il
    // la lève aussi longtemps que le fond tarde ou ne vient jamais (unpkg
    // injoignable). Une page qui pose des points regroupés perdrait ses points
    // faute de fond. Le plafond ne dépend pas de la couche : il n'a aucune raison
    // de l'attendre.
    map.setMaxZoom(plafond);

    return charger().then(function () {
      // L'ATTRIBUTION PASSE PAR attributionControl.customAttribution, pas par
      // l'option attribution. Le pont redéfinit getAttribution() : il lit
      // options.attributionControl.customAttribution, et à défaut il va chercher
      // le champ attribution des sources du style, que le style IGN ne porte pas.
      // Une option attribution serait donc lue par personne. Cet objet ne fuit
      // pas vers MapLibre : le pont force attributionControl:false côté GL.
      var couche = global.L.maplibreGL({
        style: STYLE,
        attributionControl: { customAttribution: ATTRIBUTION }
      }).addTo(map);

      if (options.opacite !== undefined && couche.getContainer()) {
        couche.getContainer().style.opacity = String(options.opacite);
      }

      var glMap = couche.getMaplibreMap();
      return new Promise(function (resoudre) {
        glMap.on('load', function () {
          appliquerReglages(glMap, paleur);
          resoudre(couche);
        });
      });
    });
  }

  // ── POSE DIFFÉRÉE, À L'ENTRÉE DANS LE CHAMP DE L'ÉCRAN ─────────────────
  // Pour l'accueil public seul : MapLibre pèse 275 ko gzip, et la carte de
  // démonstration commence à 963 px du haut du document (mesuré au banc en 1440
  // de large) : elle n'est jamais visible sans défilement. Un visiteur qui ne
  // fait pas défiler la page ne télécharge donc rien. Sur une fenêtre de 900 px
  // de haut, la carte n'est qu'à 63 px sous le pli, donc dans la marge d'avance
  // de 200 px posée plus bas : le fond part alors aussitôt, et le report ne mord
  // que sur les fenêtres plus courtes (mesuré : rien de chargé en 1440x500 tant
  // qu'on ne défile pas).
  //
  // La promesse rendue est celle de poser() : elle ne se résout qu'une fois le
  // fond peint. C'est à elle que la mise en scène de la démonstration s'accroche,
  // pour que les points ne se posent jamais sur un cadre vide.
  function poserAuDefilement(map, element, options) {
    return new Promise(function (resoudre, rejeter) {
      function allumer() {
        poser(map, options).then(resoudre, rejeter);
      }
      // Repli sans observateur (navigateur ancien) : on pose tout de suite,
      // plutôt que de laisser une carte sans fond.
      if (!element || typeof IntersectionObserver === 'undefined') { allumer(); return; }
      // MILLE PIXELS D'AVANCE, ET NON DEUX CENTS. Le montage du fond se mesure
      // au-delà de deux secondes cache froid : 200 px ne couvraient pas ce délai,
      // le visiteur arrivait sur la carte avant qu'elle ne soit peinte et voyait
      // un cadre blanc, la démonstration attendant le fond pour poser ses points.
      // Mille pixels déclenchent le chargement bien avant l'entrée à l'écran.
      //
      // CE QUE CELA COÛTE : l'économie du report tient toujours, un visiteur qui
      // ne descend pas ne charge rien, mais le seuil se déplace. Celui qui
      // s'arrête à moins de mille pixels de la carte paiera le chargement sans
      // voir la carte. C'est le compromis retenu.
      var observateur = new IntersectionObserver(function (entrees) {
        for (var i = 0; i < entrees.length; i++) {
          if (!entrees[i].isIntersecting) continue;
          observateur.disconnect();
          allumer();
          return;
        }
      }, { rootMargin: '1000px' });
      observateur.observe(element);
    });
  }

  global.MUPFond = {
    STYLE: STYLE,
    ATTRIBUTION: ATTRIBUTION,
    charger: charger,
    poser: poser,
    poserAuDefilement: poserAuDefilement
  };
})(window);
