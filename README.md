# DropMeme

Les médias d’un salon Discord, directement sur les écrans des abonnés. Un serveur **Fastify 5.12.5** sur un mini-PC Linux et une application Windows **Tauri 2**, sans Electron. Interface en français, sans framework UI, sans dégradés.

Le bot reçoit les nouveaux messages via le Gateway Discord. Il diffuse les médias aux appareils abonnés par WebSocket. Le client les affiche dans une fenêtre transparente, sans bordure, au-dessus des autres fenêtres, sans prendre le focus et en laissant passer les clics.

## Fonctionnalités

- Abonnement à un salon avec un code privé généré par `/dropmeme`, ou ID du salon + clé d’invitation administrateur.
- Images, GIF, vidéos MP4/WebM et audio MP3/OGG/WAV/M4A, selon les codecs disponibles dans WebView2. Les images de liens passant par le proxy Discord sont aussi acceptées.
- Écran, placement libre par glisser-déposer, dimensions, opacité, durée maximale de 2 à 120 secondes, volume et son. Le son est désactivé par défaut ; l’audio seul est ignoré lorsqu’il est muet.
- File FIFO limitée, déduplication, filtres par format, pause, passage au média suivant et aperçu. La pause ignore les nouveaux médias ; elle ne les rejoue pas ensuite. Les médias en attente depuis plus de cinq minutes sont abandonnés.
- Zone de notification, ouverture avec Windows, reconnexion automatique. Les réglages sont enregistrés localement et le jeton dans le gestionnaire d’identifiants Windows.
- SQLite local : aucun Redis, PostgreSQL ou service de compte utilisateur à exploiter.

Un appareil est abonné à **un salon à la fois**. Pour changer de salon, désabonnez-le puis connectez-le avec une nouvelle invitation. Seuls les nouveaux messages sont transmis, sans historique ni téléchargement lorsque personne ne consulte un média. Les GIF en pièce jointe et ceux du sélecteur Discord/Tenor sont pris en charge, y compris leurs embeds ajoutés après l’envoi. Les animations Tenor encodées en MP4 sont bouclées et suivent le filtre **Images & GIF**, pas le filtre Vidéos. Les pages externes et les lecteurs YouTube/Giphy ne sont jamais exécutés.

## Préparer Discord

1. Créez une application et son bot dans le [Discord Developer Portal](https://discord.com/developers/applications).
2. Activez **Message Content Intent** dans la section Bot. Sans cet intent privilégié, Discord peut masquer les pièces jointes et embeds. Les bots vérifiés doivent demander l’autorisation correspondante à Discord.
3. Invitez le bot dans le serveur avec les scopes `bot` et `applications.commands` et les permissions **View Channels**. Il n’a pas besoin d’Administrator, d’envoyer des messages publics ou de lire l’historique.
4. Activez le mode développeur Discord et copiez l’ID du serveur, de l’application et des salons autorisés.

La commande `/dropmeme` est enregistrée au démarrage uniquement dans le serveur configuré, sans supprimer les autres commandes du bot. Sa réponse est éphémère et contient un code à usage unique valable 10 minutes. Il faut pouvoir voir le salon pour générer ce code. Un administrateur peut aussi restreindre l’accès à la commande dans les paramètres des intégrations Discord.

## Déployer sur le mini-PC Linux

Prérequis : Docker Engine + Compose et un reverse proxy HTTPS existant, par exemple Traefik ou celui de Coolify. Ce Compose lance uniquement DropMeme : aucun proxy supplémentaire et aucun port 80/443 publié. Le proxy doit pouvoir joindre le service `server` sur son port interne **3000** et relayer les WebSockets.

```sh
cp .env.example .env
chmod 600 .env
```

Renseignez `.env` dans un éditeur : `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `ALLOWED_CHANNEL_IDS` et `PUBLIC_URL`. `PUBLIC_URL` est l’adresse HTTPS routée par Traefik, sans chemin. Ne commitez jamais ce fichier. Avec Coolify, renseignez ces valeurs dans les variables du service, attribuez son domaine HTTPS au service `server` et sélectionnez le port cible `3000`. Avec un Traefik autonome, rattachez `server` au réseau Docker existant du proxy et configurez sa route vers ce port ; le nom de ce réseau dépend de votre installation.

`JOIN_KEY` est optionnel : sans cette variable, seul le code Discord permet de s’abonner. Pour autoriser l’abonnement par ID, générez une clé avec `openssl rand -hex 32`, renseignez-la dans `.env` et partagez-la uniquement avec les abonnés autorisés. Elle donne accès à **tous les salons de la liste autorisée** ; utilisez les codes pour déléguer l’accès salon par salon.

```sh
docker compose up -d --build
docker compose logs --tail=100 server
curl --fail https://dropmeme.example.com/readyz
```

Traefik gère HTTPS et relaie les WebSockets. Les données SQLite sont conservées dans le volume `dropmeme_data`. `/healthz` indique que le processus fonctionne ; `/readyz` renvoie 503 si Discord est déconnecté. L’application cliente indique alors « Discord indisponible ».

Le bot valide les salons au démarrage. Un mauvais token, un intent non activé ou un salon inaccessible fait échouer le démarrage avec un diagnostic. Les plafonds par défaut sont 25 Mo par média, 100 appareils enregistrés, un cache média de 64 Mo et quatre téléchargements simultanés. Le téléchargement est partagé entre les clients ; chaque affichage utilise néanmoins la bande passante sortante du mini-PC. Ajustez `MAX_MEDIA_MB` et `MAX_CLIENTS` pour votre machine. La limitation des tentatives d’invitation est globale derrière le proxy (10 par minute), intentionnellement conservatrice pour un petit serveur.

### Discord « Missing Access » et conteneur unhealthy

Le serveur attend l’initialisation Discord avant d’écouter sur le port 3000. Si Discord refuse l’accès, le processus s’arrête et le healthcheck échoue ; le diagnostic utile se trouve dans les **logs du service server**, pas dans la trace du déploiement Coolify.

Au démarrage, DropMeme vérifie que `DISCORD_APPLICATION_ID` correspond au token fourni, que `DISCORD_GUILD_ID` est accessible au bot, puis enregistre `/dropmeme`. Un échec indique l’opération concernée sans afficher de secret.

- **Identification du bot / 401** : `DISCORD_TOKEN` doit être le token de la section Bot du Developer Portal, pas le client secret OAuth.
- **Accès au serveur / 50001 ou 10004** : `DISCORD_GUILD_ID` doit être l’ID du serveur Discord, pas un ID de salon. Vérifiez que ce même bot figure dans la liste des membres du serveur.
- **Enregistrement de /dropmeme / 50001** : réinvitez cette application dans le serveur avec les scopes `bot` et `applications.commands` depuis OAuth2 → URL Generator. Il n’est pas nécessaire de lui donner Administrator.
- **Salon inaccessible** : tous les IDs de `ALLOWED_CHANNEL_IDS` doivent appartenir à ce serveur, et le bot doit avoir View Channel dans chacun, y compris dans les salons privés.

Après correction des variables ou de l’installation Discord, redéployez. Retirer le healthcheck ne corrige pas un refus d’accès Discord.

Pour sauvegarder SQLite, arrêtez le service avant de copier le volume `dropmeme_data`, puis redémarrez-le ; préservez aussi les fichiers `-wal` et `-shm` s’ils existent. Les fichiers média ne sont pas archivés. Modifier `ALLOWED_CHANNEL_IDS` puis recréer le serveur retire l’accès aux salons concernés, y compris pour les jetons existants.

## Installer Windows

Le workflow **Checks** construit un installeur NSIS `.exe` à chaque push sur `main` et chaque PR. Téléchargez l’artefact **DropMeme-Windows-x64** dans l’onglet Actions de GitHub. Windows 10/11 x64 est ciblé. L’installeur installe WebView2 si nécessaire ; l’application utilise le runtime partagé de Windows au lieu d’embarquer Chromium.

Un tag `v0.1.0`, ou autre version cohérente avec les fichiers du projet, déclenche **Windows release** : build, tests, somme SHA-256 et création d’une **GitHub Release en brouillon** contenant l’installeur. `workflow_dispatch` génère uniquement l’artefact. Pour changer de version, mettez à jour les `package.json`, `Cargo.toml`, `tauri.conf.json` et les lockfiles avant de poser le tag. Le projet ne contient pas de certificat de signature Windows : les installeurs générés seront non signés, et SmartScreen peut demander une confirmation. Aucune mise à jour automatique n’est activée.

Dans l’application : saisissez l’URL HTTPS du serveur, puis votre code Discord ou l’ID du salon et la clé d’invitation. Choisissez vos réglages et utilisez « Tester l’affichage ». Fermer la fenêtre la réduit dans la zone de notification ; utilisez le menu **Quitter** pour arrêter l’application. Le mode plein écran exclusif de certains jeux peut masquer la superposition ; utilisez le plein écran sans bordure.

### Placer les médias sur votre écran

Choisissez un écran (sa résolution est affichée), puis **Placer sur l’écran**. Faites glisser le petit onglet DropMeme sur l’écran voulu, étirez le coin inférieur droit pour régler la taille et cliquez sur **✓** pour enregistrer ; **×**, Échap ou Alt+F4 annulent. Vous pouvez déplacer le cadre vers un autre moniteur : cet écran est alors sélectionné automatiquement. La zone entière du cadre est la zone d’affichage, l’image conserve ses proportions à l’intérieur.

Chaque écran conserve sa propre disposition : un 49″ en 5120×1440 peut avoir une zone différente d’un 27″ en 2560×1440. Les coordonnées sont relatives au moniteur et les dimensions en pixels logiques, avec prise en compte du DPI Windows ; la zone est limitée à la surface de l’écran si sa résolution change. Les positions prédéfinies restent disponibles. Pendant le placement, les nouveaux médias sont ignorés. En lecture normale, le cadre et l’onglet disparaissent : la superposition laisse à nouveau passer les clics sans prendre le focus.

L’aperçu utilise un vrai GIF animé embarqué, sans dépendre de Discord ou du serveur. Si même cet aperçu échoue, vérifiez le message affiché dans l’application, redémarrez DropMeme et vérifiez WebView2. Pour la correction **0.1.1**, quittez l’ancienne application depuis la zone de notification, installez le nouvel `.exe` du workflow Checks et redéployez aussi le serveur pour recevoir les GIF du sélecteur Discord. Les préférences et l’abonnement existants sont conservés.

## Développement

Node.js **24**, npm et Rust stable sont nécessaires. Les versions JS et Rust sont verrouillées dans `package-lock.json` et `Cargo.lock`.

```sh
npm ci
npm run check
npm test
npm run build
```

Serveur local : créez `.env`, utilisez `PUBLIC_URL=http://localhost:3000`, puis :

```sh
npm run dev:server
```

Client natif sous Windows : installez les [prérequis Tauri](https://v2.tauri.app/start/prerequisites/) (MSVC Build Tools, Rust et WebView2), puis :

```sh
npm run dev:desktop
npm run build:windows -- --ci
```

L’installeur est généré dans `packages/desktop/src-tauri/target/release/bundle/nsis/`. L’icône source est `packages/desktop/app-icon.svg` ; régénérez les formats natifs avec `npm run tauri -w @dropmeme/desktop -- icon app-icon.svg --output src-tauri/icons`.

Le frontend peut aussi être prévisualisé dans un navigateur : `npm run build:shared`, puis `npm run dev -w @dropmeme/desktop`. Dans ce mode, l’aperçu est une iframe et le jeton reste uniquement en mémoire ; la zone de notification, la persistance des identifiants, les écrans multiples et le démarrage automatique nécessitent l’application native. Le client Linux est un outil de développement : ses identifiants restent en mémoire. Le support distribué vise Windows.

Tests de navigateur :

```sh
npx playwright install --with-deps chromium
npm run test:e2e
```

Les tests couvrent les invitations, leur expiration, l’authentification WebSocket, l’isolation des salons, la révocation, les tickets média, les formats/tailles, le cache et les requêtes Range, la file d’attente, le placement multi-écran et les parcours UI. Ils ne remplacent pas un essai avec un vrai bot Discord et un écran Windows : ces deux validations nécessitent les identifiants et la plateforme correspondants.

## Sécurité et limites

Les IDs de salons ne sont pas des secrets. Les codes et jetons sont stockés hachés côté serveur, et les tickets de média sont signés et expirent après 30 minutes. La révocation d’un appareil coupe son WebSocket et ses nouveaux téléchargements. Les médias déjà téléchargés chez l’utilisateur ne peuvent pas être retirés à distance. Les réponses ne contiennent pas le texte des messages. Les contenus HTML/SVG et les redirections externes sont refusés ; les téléchargements utilisent TLS et sont bornés en taille et durée.

Il n’y a pas de panneau administrateur, d’OAuth Discord individuel, d’historique, de synchronisation des réglages ni de diffusion multi-salon dans cette première version. Les invitations sont des accès délégués : gardez-les privées. Toute personne possédant un code valide peut appairer un appareil, même sans compte Discord sur celui-ci.

Sources consultées pour l’architecture et les versions : [registre officiel Fastify](https://registry.npmjs.org/fastify/latest), [politique LTS Fastify](https://github.com/fastify/fastify/blob/main/docs/Reference/LTS.md), [Discord Gateway](https://discord.com/developers/docs/events/gateway), [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
