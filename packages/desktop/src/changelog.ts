export const changelog = [
  { version: '0.4.1', changes: [
    'Les nouvelles versions s’installent obligatoirement au lancement, puis DropMeme redémarre tout seul.',
  ] },
  { version: '0.4.0', changes: [
    'Nouvelle interface en onglets : plus besoin de faire défiler les réglages.',
    'Le pseudo du compte Discord lié par le code /dropmeme s’affiche dès l’abonnement.',
    'Textes et légendes en style mème : Comic Sans blanc à contour noir, centrés et plus grands.',
    'Le bouton de mise à jour indique la raison exacte d’un échec.',
  ] },
  { version: '0.3.0', changes: [
    'Textes et GIF simultanés dans les mêmes zones ; vidéos ordinaires une par une.',
    'Les zones gardent leur ordre et leur numéro après modification.',
    'Liaison à votre compte Discord avec un code privé /dropmeme, sans se désabonner.',
    'Mentionnez une ou plusieurs personnes dans Discord pour cibler uniquement leurs appareils liés et consentants du même salon.',
    'Texte accompagnant le GIF ou la vidéo, au-dessus ou en dessous ; les mentions de destinataires sont masquées.',
    'Un seul envoi pour le texte et le fichier depuis l’application. Réglages et abonnements conservés.',
  ] },
  { version: '0.2.0', changes: [
    'Durées séparées pour les GIF, les vidéos et les images ou textes.',
    'Personnes connectées au salon et envois ciblés avec consentement du destinataire.',
    'Envoi de texte et de fichiers depuis l’application ; nom de l’expéditeur affiché.',
    'MOV convertis en MP4 sur le serveur ; WebP animés conservés.',
    'Plusieurs GIF simultanés en option, placement aléatoire ou zones personnalisées par écran.',
    'Version, historique et téléchargement des mises à jour signées dans l’application.',
  ] },
  { version: '0.1.1', changes: ['Correction de l’ouverture de la superposition et placement manuel sur chaque écran.', 'Prise en charge des GIF Discord et Tenor, y compris les aperçus reçus après le message.'] },
  { version: '0.1.0', changes: ['Première version : abonnement Discord, superposition, file d’attente et réglages locaux.'] },
];
