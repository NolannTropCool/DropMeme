# Historique DropMeme

## 0.4.0

- Nouvelle interface en onglets (Accueil, Affichage, Médias, Envois, Application) : plus besoin de faire défiler les réglages.
- L’abonnement par code `/dropmeme` affiche directement le pseudo du compte Discord lié ; un autre compte peut être lié en un clic.
- Textes et légendes en style mème : Comic Sans blanc à contour noir, centrés, plus grands, sans fond.
- Le bouton de mise à jour indique la raison exacte d’un échec.
- Publication fiabilisée : tag `v<version>` vérifié dès le début, fins de ligne LF, contrôle de la clé de signature, release créée depuis GitHub complétée automatiquement.

## 0.3.0

- Textes et GIF affichables simultanément, en placement aléatoire ou dans les zones personnalisées ; les vidéos ordinaires restent exclusives et passent une par une.
- Modification des zones sans changer leur ordre ni leur numéro.
- Liaison du compte Discord par code privé `/dropmeme`, y compris pour les appareils déjà abonnés.
- Mentions Discord : envoi uniquement aux appareils liés des personnes mentionnées, connectés au même salon et consentants. Aucun repli vers une diffusion au salon.
- Texte accompagnant un GIF ou une vidéo affiché comme légende au-dessus ou en dessous, pendant toute sa lecture. Les mentions de destinataires sont retirées de l’affichage.
- Depuis l’application, texte et fichier partent dans un seul envoi. Migration automatique de SQLite et des préférences, sans perdre les abonnements.

## 0.2.0

- Durées séparées pour les GIF, vidéos, images et textes.
- Personnes connectées au salon et envois ciblés avec consentement explicite.
- Envoi de texte et de fichiers depuis l’application, avec nom de l’expéditeur.
- Conversion des MOV en MP4 sur le serveur et conservation des WebP animés.
- Affichage simultané de 2 à 8 GIF en option, placement aléatoire ou zones personnalisées par écran.
- Version et historique dans l’application ; mises à jour Windows signées avec téléchargement et installation intégrés.

## 0.1.1

- Correction de l’ouverture de la superposition et placement manuel par écran.
- GIF Discord et Tenor, y compris les aperçus ajoutés après réception du message.

## 0.1.0

- Abonnement Discord, superposition, file d’attente, réglages et installateur Windows.
