/* ─────────────────────────────────────────────────────────────────
   MUPFond : le fond de carte du produit, en un seul exemplaire.

   Plan IGN vectoriel (Géoplateforme), rendu par MapLibre GL posé dans
   Leaflet par le pont @maplibre/maplibre-gl-leaflet : Leaflet reste le
   moteur, il garde la vue, les panes, les marqueurs et les bulles,
   seul le fond change.

   TOUTE SURFACE QUI PORTE UNE CARTE PASSE PAR ICI : carte, dashboard,
   accueil, pipeline, prospection, statistiques. Le style, l'attribution,
   le plafond de zoom, les deux registres d'extinction, les trois
   transpositions vers le blanc (routes, surfaces d'eau, toponymes) et
   leurs facteurs vivent dans ce fichier et nulle part ailleurs. Une page
   qui veut s'écarter du réglage commun le demande par PARAMÈTRE D'APPEL
   (plafondZoom, opacite, paleurRoutes) ; elle ne recopie rien. Une
   recopie ferait diverger les réglages au premier changement. Les deux
   facteurs des surfaces d'eau et des toponymes n'ont, eux, pas de
   paramètre : aucune page n'a demandé à s'en écarter, et un réglage de
   fond qui ne varie pas ne prend pas de porte d'entrée.

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
  // 94 couches, 98 propriétés de couleur au relevé du style. Le trait de la route
  // seul : les toponymes routiers (bornes, numéros, odonymes) ont désormais leur
  // propre facteur, plus bas.
  //
  // PALEUR_ROUTES : 0 laisse la couleur d'origine, 1 rend du blanc pur. Un seul
  // chiffre à changer pour rendre les routes plus ou moins présentes, sur toutes
  // les cartes du produit à la fois.
  var PALEUR_ROUTES = 0.6;
  var COUCHES_ROUTIERES = ['routier_route', 'routier_route_sup', 'routier_route_sou',
    'routier_liaison', 'routier_surf'];

  // SURFACES D'EAU ATTÉNUÉES. Le style gris pose la mer, l'estran et les étendues
  // d'eau en aplats gris soutenus (#CFCFCF, #DCDCDC, #D4D4D4) : sur une côte
  // découpée, une baie occupe la moitié du cadre et pèse plus lourd que les points
  // de fiches posés dessus. Même mécanique que les routes, transposition vers le
  // blanc canal par canal, alpha jamais touché.
  //
  // LE PÉRIMÈTRE SE PREND PAR SOURCE-LAYER, ET « hydro_surf » SE PREND EN ENTIER.
  // C'est le relevé du 27 août qui l'impose : la couche « hydro surfacique » porte
  // la mer ET les eaux intérieures d'un même trait, sous une étiquette « symbo »
  // qui change avec le zoom (ZONE_MARINE, SURFACE_D_EAU, BASSIN) ; un filtre sur
  // l'étiquette aurait laissé à pleine force ce qu'elle ne nomme pas au zoom
  // courant. On teint la couche entière, sans filtrer. Les quatre autres couches du
  // source-layer sont de la même eau : estran, lagon, surface temporaire, marais.
  //
  // L'ESTRAN Y EST, ET IL LE FAUT. Il borde toute la côte bretonne, où se fait le
  // gros des tournées. Laissé à #DCDCDC pendant que la mer s'éclaircit, il aurait
  // fait tout au long du littoral un liseré plus soutenu que l'eau qu'il longe :
  // l'inverse exact du geste.
  //
  // Deux couches ne coûtent rien au relevé : « hydro surfacique - marais » ne peint
  // qu'un fill-pattern, sans propriété de couleur, donc rien à transposer et rien à
  // compter. Et les cours d'eau restent dehors : ce sont des traits, pas des
  // aplats, et hydro_reseau n'est pas dans ce périmètre.
  //
  // PALEUR_SURFACES_EAU : 0 laisse la couleur d'origine, 1 rend du blanc pur.
  var PALEUR_SURFACES_EAU = 0.2;
  var COUCHES_SURFACES_EAU = ['hydro_surf'];

  // CONTOUR DE L'HYDRO SURFACIQUE. Quand fill-outline-color est absent, MapLibre
  // trace le bord du polygone dans la couleur de l'aplat : l'eau n'a aucun trait
  // à elle, son contour ne vaut que ce que vaut son remplissage une fois pâli.
  // Tant que « limite cote » est allumée, le littoral tient par ce liseré ; mais
  // sa donnée LIM_COTE s'arrête au niveau 9, et au franchissement du zoom 11 le
  // trait de côte s'éteint d'un coup sans que rien ne prenne le relais. C'est
  // cette rupture de densité qui décide ici, pas l'aspect : on désolidarise la
  // valeur du contour de celle de l'aplat, sur la seule couche « hydro
  // surfacique », pour que le bord de l'eau cesse de dépendre du pâlissement de
  // son intérieur.
  //
  // LA VALEUR S'ÉCRIT BRUTE, avant la passe de pâlissement. Posée sur la couche,
  // elle est relue par palirCouches comme n'importe quelle propriété de couleur
  // du périmètre, et emprunte donc le chemin commun sans traitement à part.
  // #8C8C8C rend #A3A3A3 au facteur 0.2, à trois points du #A0A0A0 de « limite
  // cote » : le relais se prend à densité égale.
  //
  // CE QUE CELA CERNE EN PLUS, ET C'EST ACCEPTÉ : la couche porte la mer et les
  // eaux intérieures d'un même trait, sans que l'étiquette « symbo » permette de
  // les séparer au zoom courant. Lacs, bassins et étendues d'eau reçoivent donc
  // le même contour dès le zoom 8, où la couche entre. Un plan d'eau cerné ne
  // coûte rien à la lecture d'une tournée ; un littoral qui se dissout, si.
  var COUCHE_HYDRO_SURF = 'hydro surfacique';
  var CONTOUR_HYDRO_SURF = '#8C8C8C';

  // TOPONYMES ATTÉNUÉS. Le style écrit ses noms en noir franc (#000000 pour les
  // communes, les quartiers et les lieux-dits) et en gris soutenus pour le reste :
  // sur un fond dont les routes et les eaux viennent de reculer, ce sont eux qui
  // restent en avant, et ils tiennent tête aux points de fiches.
  //
  // LE PÉRIMÈTRE SE PREND AU PRÉFIXE DU SOURCE-LAYER. Les 15 source-layers de
  // texte du style commencent tous par « toponyme » et aucun autre ne commence
  // ainsi : le préfixe désigne exactement la famille, sans liste à tenir à jour.
  // 131 couches, 240 propriétés de couleur au relevé du style.
  //
  // LE HALO ENTRE DANS LE PÉRIMÈTRE, comme tout ce qui porte « color », et il n'y
  // perd presque rien : sur les 240 propriétés, 106 sont des halos, dont 103 déjà
  // blancs que la transposition vers le blanc laisse blancs, alpha compris. Le
  // geste ne porte donc en pratique que sur les 131 couleurs de texte et les 3
  // couleurs d'icône. Restent deux couches à contre-emploi, le numéro de route
  // nationale et celui d'autoroute, écrits en clair sur un halo sombre : leur halo
  // s'éclaircit lui aussi et le cartouche pâlit des deux côtés. C'est le prix d'un
  // périmètre pris d'un bloc, et il se paie sur deux couches qui ne portent pas la
  // lecture d'une tournée.
  //
  // PALEUR_TOPONYMES : 0 laisse la couleur d'origine, 1 rend du blanc pur.
  var PALEUR_TOPONYMES = 0.5;
  var PREFIXE_TOPONYME = 'toponyme';

  // TRAIT DE CÔTE PAR LA LAISSE DE HAUTE MER. La source livre « hydro_laisse »
  // dans ses tuiles, et le style gris ne porte aucune couche dessus. C'est donc
  // la seule couche que ce module AJOUTE : partout ailleurs il n'éteint, ne
  // pâlit ou ne repeint que de l'existant.
  //
  // POURQUOI ELLE. « limite cote » s'arrête au franchissement du zoom Leaflet
  // 11, sa donnée LIM_COTE n'existant pas au-delà, et le littoral retombe alors
  // sur le seul contour de l'eau. Or ce contour est le bord d'un polygone de
  // marée : il cerne l'eau à sa pleine étendue modélisée, estran compris, et non
  // la côte, si bien qu'il court au large de la laisse partout où l'estran
  // découvre. Les 77 à 4 080 m relevés sur ce polygone valent pour le niveau n1,
  // qui n'entre qu'au zoom Leaflet 14, là où la laisse peint déjà ; aux zooms où
  // le contour prend seul le relais, c'est un niveau plus généralisé qui est
  // servi et son écart à la côte n'a pas été mesuré. La laisse de haute mer,
  // elle, suit ce qu'un habitant appelle la côte, à 12 à 108 m en médiane sur
  // les trois sites de contrôle.
  //
  // CE QU'ELLE COUVRE VARIE FORTEMENT SELON LE SECTEUR. Les 94 % du littoral au
  // niveau n10 et les 100 % au niveau n0 ont été relevés sur Saint-Malo seul ;
  // sur Saint-Pair et Kairon, la même mesure donne 36 à 63 %. Il n'y a donc pas
  // de taux de couverture à annoncer pour le littoral en général, seulement
  // secteur par secteur.
  //
  // LE SYMBO CHANGE D'ORTHOGRAPHE AVEC LE NIVEAU, ET LE FILTRE PREND LES DEUX :
  // « LAISSES_HAUTES_MERS » au pluriel au niveau généralisé n10, qui est le seul
  // servi au zoom Leaflet 13, « LAISSE_HAUTES_MERS » au singulier au niveau
  // détaillé n0, servi des zooms 14 à 18. N'en inscrire qu'une éteindrait le
  // trait sur une partie de la plage. Les deux étant prises, la même couche
  // continue de peindre au passage de 13 à 14, sans clignotement : la géométrie
  // se détaille sur place.
  //
  // « LAISSE_BASSES_MERS » RESTE DEHORS. Elle entre dans la donnée au zoom 14 et
  // court au large, à la largeur de l'estran : dessinée, elle doublerait le trait
  // de côte sur tout le littoral.
  //
  // AU NIVEAU n10, LA BASSE MER PASSE QUAND MÊME, ET C'EST ACCEPTÉ. L'IGN y verse
  // la laisse de basse mer sous le symbo de la haute : entre 39 et 54 % du
  // linéaire admis au zoom Leaflet 13 dessine donc la basse mer, à 1,5 km au
  // large sur les côtes à estran. Aucun filtre ne peut les séparer, les trois
  // attributs de la source-layer étant constants et aucune entité ne portant
  // d'identifiant. C'est une limite de la source acceptée, pas un défaut à
  // corriger : au zoom 14 le niveau n0 reprend, sous ses deux symbos distincts,
  // et le trait revient sur la seule haute mer.
  //
  // LA DONNÉE S'ARRÊTE AU ZOOM LEAFLET 18. Les tuiles du 19 sont bien servies et
  // ne portent pas la source-layer : il n'y a pas de sur-zoom à attendre, le
  // trait s'éteint sec au dernier cran, où le littoral revient au contour de
  // l'eau, trois points plus clair. Rien ne compense : le zoom 19 se vise sur une
  // adresse, pas sur une côte. Aucun minzoom ni maxzoom n'est déclaré non plus :
  // l'étendue de la donnée décide seule des zooms où la couche peint. Ce n'est
  // pas pour autant un meilleur bornage qu'un chiffre écrit, car au niveau n10
  // cette étendue ne borne rien d'utile : elle y verse les deux laisses sous un
  // symbo unique.
  //
  // LA COULEUR S'ÉCRIT À SA VALEUR FINALE, à l'inverse du contour de l'eau qui
  // s'écrit brut pour être relu : la couche est posée APRÈS les trois passes de
  // pâlissement, qui ne la voient donc pas, et aucun des trois périmètres ne
  // porte « hydro_laisse ». #A0A0A0 est exactement le gris de « limite cote »,
  // jamais pâlie elle non plus : le trait de côte garde ainsi une valeur unique
  // sur toute sa vie, et le contour de l'eau qui assure le relais hors de la
  // plage sort à #A3A3A3. Largeur 1, celle de « limite cote », et celle du filet
  // que trace fill-outline-color.
  var SOURCE_LAYER_LAISSE = 'hydro_laisse';
  var COUCHE_LAISSE = 'mup - trait de cote';
  var SYMBO_LAISSE_HAUTE = ['LAISSES_HAUTES_MERS', 'LAISSE_HAUTES_MERS'];
  var COULEUR_LAISSE = '#A0A0A0';
  var LARGEUR_LAISSE = 1;

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

    signalerReleve('routière', palirCouches(glMap, paleur, function (couche) {
      return COUCHES_ROUTIERES.indexOf(couche['source-layer']) >= 0;
    }));
    // LE CONTOUR SE POSE AVANT LA PASSE, et c'est tout le montage : palirCouches
    // relit le style, il y trouvera cette propriété et la traitera avec les
    // autres couleurs du périmètre. Posée après, elle resterait brute.
    if (glMap.getLayer(COUCHE_HYDRO_SURF)) {
      glMap.setPaintProperty(COUCHE_HYDRO_SURF, 'fill-outline-color', CONTOUR_HYDRO_SURF);
    } else {
      console.warn('Plan IGN : couche « ' + COUCHE_HYDRO_SURF + ' » absente du style, '
        + 'contour de l\'eau non posé, libellé renommé côté IGN.');
    }
    signalerReleve("de surface d'eau", palirCouches(glMap, PALEUR_SURFACES_EAU, function (couche) {
      return COUCHES_SURFACES_EAU.indexOf(couche['source-layer']) >= 0;
    }));
    signalerReleve('de toponyme', palirCouches(glMap, PALEUR_TOPONYMES, function (couche) {
      var source = couche['source-layer'];
      return typeof source === 'string' && source.indexOf(PREFIXE_TOPONYME) === 0;
    }));

    // EN DERNIER, ET C'EST VOULU : posée après les trois passes, la couche n'est
    // relue par aucune d'elles et sa couleur reste celle qui est écrite.
    poserTraitDeCote(glMap);
  }

  // LA TRANSPOSITION EST LA MÊME POUR LES TROIS PÉRIMÈTRES, elle n'est donc
  // écrite qu'une fois : les routes, les surfaces d'eau et les toponymes ne
  // diffèrent que par la couche retenue et par le facteur. Rend le relevé, à
  // charge de l'appelant de le signaler.
  function palirCouches(glMap, facteur, estConcernee) {
    var releve = { chaines: 0, rampes: 0, intactes: 0 };
    glMap.getStyle().layers.forEach(function (couche) {
      if (!estConcernee(couche)) return;
      var peinture = couche.paint || {};
      Object.keys(peinture).forEach(function (propriete) {
        if (propriete.indexOf('color') < 0) return;
        var valeur = peinture[propriete];
        if (typeof valeur === 'string') {
          var pale = palirCouleur(valeur, facteur);
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
            var pale2 = palirCouleur(palier[1], facteur);
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
    return releve;
  }

  // Un silence ne doit pas passer pour un traitement : ce qui n'a pas été relu
  // se dit, périmètre par périmètre, avec son dénominateur.
  function signalerReleve(famille, releve) {
    if (!releve.intactes) return;
    console.warn('Plan IGN : ' + releve.intactes + ' propriété(s) de couleur ' + famille
      + ' laissée(s) intacte(s) sur ' + (releve.chaines + releve.rampes + releve.intactes)
      + ', forme de valeur non reconnue.');
  }

  // ── POSE DU TRAIT DE CÔTE ──────────────────────────────────────
  // AUCUN IDENTIFIANT IGN EN CLAIR NE SERT D'ANCRAGE ICI, ni pour la source ni
  // pour le rang : un identifiant de style est un libellé que l'IGN renomme sans
  // prévenir, un nom de source-layer tient. Les deux se retrouvent donc par leur
  // source-layer, la forme que ce fichier préfère partout ailleurs.

  // La source des tuiles se lit sur l'eau : le trait de côte doit venir des mêmes
  // tuiles que le polygone qu'il borde, et l'eau a déjà son périmètre nommé.
  function trouverSourceEau(glMap) {
    var couches = glMap.getStyle().layers;
    for (var i = 0; i < couches.length; i++) {
      if (COUCHES_SURFACES_EAU.indexOf(couches[i]['source-layer']) >= 0) return couches[i].source;
    }
    return null;
  }

  // LE RANG SE PREND SOUS LE PREMIER TOPONYME. addLayer insère SOUS l'ancre :
  // rendre l'identifiant du premier toponyme du style place donc le trait
  // au-dessus de tous les aplats (l'eau pâlie comprise, sans quoi il s'y
  // noierait), de toutes les routes, du ferré et du bâti surfacique, et sous tous
  // les noms sans exception, sous les ponctuels et sous les sept lignes de
  // bati_lin. Ce sont les seules choses qui passeront par-dessus lui aux zooms 13
  // à 18 : lignes électriques et câbles. Rien de ce que MUP pose n'est en jeu,
  // marqueurs, tracé et bulles vivant dans des panes Leaflet au-dessus du canvas
  // GL entier.
  function trouverAncreToponyme(glMap) {
    var couches = glMap.getStyle().layers;
    for (var i = 0; i < couches.length; i++) {
      var source = couches[i]['source-layer'];
      if (typeof source === 'string' && source.indexOf(PREFIXE_TOPONYME) === 0) return couches[i].id;
    }
    return null;
  }

  // TROIS REPLIS, ET AUCUNE POSE SILENCIEUSEMENT RATÉE : ce que l'IGN peut
  // renommer se vérifie avant d'écrire, et se dit en console quand il manque.
  function poserTraitDeCote(glMap) {
    var source = trouverSourceEau(glMap);
    if (!source) {
      console.warn('Plan IGN : aucune couche en « ' + COUCHES_SURFACES_EAU.join(', ')
        + ' » dans le style, source des tuiles introuvable, trait de côte non posé.');
      return;
    }

    // vectorLayerIds vient de la metadata.json de la source, que MapLibre a déjà
    // chargée quand « load » se déclenche. Absente ou vide, on n'en conclut rien
    // et on pose quand même : une couche branchée sur une source-layer qui
    // n'existe pas ne dessine rien et ne casse rien, cela vaut mieux qu'un faux
    // négatif qui priverait le littoral de son trait sur un doute.
    var sourceGL = glMap.getSource(source);
    var couchesSource = sourceGL && sourceGL.vectorLayerIds;
    if (Array.isArray(couchesSource) && couchesSource.length
      && couchesSource.indexOf(SOURCE_LAYER_LAISSE) < 0) {
      console.warn('Plan IGN : source-layer « ' + SOURCE_LAYER_LAISSE + ' » absente des tuiles, '
        + 'trait de côte non posé, source-layer renommée côté IGN.');
      return;
    }

    // Sans ancre, la couche part au sommet de la pile, donc par-dessus les noms :
    // mal rangée mais visible, et signalée. Un trait de côte absent coûterait
    // davantage à la lecture qu'un trait de côte trop haut.
    var ancre = trouverAncreToponyme(glMap);
    if (!ancre) {
      console.warn('Plan IGN : aucune couche de toponyme dans le style, trait de côte posé au sommet '
        + 'de la pile, donc par-dessus les noms.');
    }

    // Filtre à l'ancienne forme, celle qu'emploient les 425 couches du style.
    var couche = {
      id: COUCHE_LAISSE,
      type: 'line',
      source: source,
      'source-layer': SOURCE_LAYER_LAISSE,
      filter: ['in', 'symbo'].concat(SYMBO_LAISSE_HAUTE),
      // La géométrie de la laisse est très dentelée : un raccord en onglet y
      // produit des pointes, le raccord rond n'en produit pas.
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': COULEUR_LAISSE, 'line-width': LARGEUR_LAISSE }
    };
    if (ancre) glMap.addLayer(couche, ancre); else glMap.addLayer(couche);
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
