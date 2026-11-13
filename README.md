# WindSector — Marseille

Carte 2D/3D du vent sur les plans d'eau marseillais : la carte est au centre, avec à gauche les
anémomètres publics et à droite l'analyse statistique des situations similaires (scénarios
gauche / droite).

## Fonctionnalités

| | |
|---|---|
| **Carte 3D / 2D** | MapLibre GL, relief réel (MNT Terrain Tiles / AWS, ombrage + terrain 3D), fond OpenFreeMap. Bouton 2D/3D. |
| **Anémomètres publics** | Météo-France (17 stations dép. 13 et 83 : Cap Couronne, Marignane, Cassis, Bec de l'Aigle, Cap Cépet…), OpenWindMap / Pioupiou (balises live), METAR (LFML, LFMI, LFMQ, LFTH). Clic → courbe vent moyen / rafales / direction + prévision superposée. |
| **Prévisions sur l'eau** | Champ de vent interpolé **découpé sur les polygones d'eau** et flèches, AROME HD 1,5 km par défaut (AROME, ARPEGE, ICON-EU, ECMWF, GFS au choix), barre temporelle animée. Clic n'importe où → série prévue. |
| **Plans d'eau** | Rade Sud (Prado / Pointe Rouge), Rade Nord, Frioul, Côte Bleue, Cassis, La Ciotat, Étang de Berre, Golfe de Fos — grille 3×3 maille fine. |
| **Analogues / scénarios** | Recherche dans l'archive horaire AROME maille fine (depuis 2023) des fenêtres avec même direction, force, heure et saison que la prévision ; calcul pour chacune de la bascule persistante (adonne à droite / refuse à gauche), de l'écart de pression droite−gauche (face au vent) et de l'oscillation → probabilités « Droite / Gauche / Neutre » par cause, histogrammes, carte d'anomalie de vent moyenne sur le plan d'eau. |
| **Vécu mesuré** | Pour chaque analogue, valeur réellement mesurée à une station Météo-France (archive horaire depuis 2020) et ratio médian mesure/modèle appliqué à la prévision du jour. |

## Sources de données

| Source | Accès | Licence |
|---|---|---|
| Météo-France — données climatologiques de base horaires | `pipeline/fetch_meteofrance.py` (pas de CORS → pré-calculé, rafraîchi toutes les 3 h par GitHub Actions) | Licence Ouverte Etalab |
| OpenWindMap / Pioupiou | API live dans le navigateur | ODbL, © contributeurs OpenWindMap |
| METAR | Iowa Environmental Mesonet (CORS) | domaine public |
| Prévisions + archive AROME | Open-Meteo (`api.open-meteo.com`, `historical-forecast-api.open-meteo.com`), décodage des GRIB2 Météo-France | CC-BY 4.0 |
| Relief | AWS Terrain Tiles (Mapzen) | voir attribution |

**GRIB maille fine historique** : l'archive utilisée par défaut est l'archive horaire Open-Meteo des
sorties GRIB AROME HD (0,01°) / AROME (0,025°). Pour constituer sa propre archive à partir de GRIB
bruts (API Météo-France, meteo.data.gouv.fr…), utiliser `pipeline/grib_to_analogdb.py` (cfgrib).

## Développement

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # dist/
python3 pipeline/fetch_meteofrance.py          # met à jour public/data/mf
python3 pipeline/build_analog_db.py --zones rade-sud   # archive AROME pré-calculée (optionnel)
pip install xarray cfgrib numpy && python3 pipeline/grib_to_analogdb.py fichiers/*.grib2
```

## Déploiement GitHub Pages

1. Settings → Pages → *Build and deployment* → Source : **Deploy from a branch**, branche **gh-pages**, dossier **/ (root)**.
2. Fusionner sur `main` : le workflow `Deploy GitHub Pages` construit et publie le site
   (puis toutes les 3 h pour rafraîchir les stations Météo-France).
3. Optionnel : lancer manuellement `Build analog archive` pour pré-calculer l'archive AROME de chaque zone
   (sinon chaque navigateur la télécharge une fois et la garde en cache IndexedDB).

## Méthode des scénarios

- Convention voile : on se place **face au vent** ; la droite du plan d'eau est le côté à +90° de la
  direction d'où vient le vent.
- *Bascule persistante* : différence de direction moyenne (dernier tiers − premier tiers de la fenêtre).
  Positive = le vent tourne à droite (adonne tribord) → côté droit payant.
- *Pression* : pente régressée de la force du vent selon la position latérale sur la grille 3×3,
  ramenée à la largeur de la zone (kt).
- Score = bascule/10° + (Δpression/force)/8 %, borné ; |score| < 0,6 → « oscillant / neutre ».
- Un seul analogue par jour (le plus proche) pour limiter l'autocorrélation.
