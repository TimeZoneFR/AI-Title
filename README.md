<div align="center">

# IA-Title

### Generateur de titres de stream propulse par IA

<br>

<img src="public/logo.png" alt="Logo" width="120">

<br><br>

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?style=for-the-badge&logo=express&logoColor=white)
![OpenAI](https://img.shields.io/badge/OpenAI-GPT--4o--mini-412991?style=for-the-badge&logo=openai&logoColor=white)
![Discord](https://img.shields.io/badge/Discord-OAuth2-5865F2?style=for-the-badge&logo=discord&logoColor=white)

<br>

*Genere des titres de stream uniques et percutants en quelques clics.*
*Authentification Discord, presets partageables, classement communautaire, panel admin complet.*

---

</div>

<br>

## Fonctionnalites

**Generation IA** &mdash; Genere des titres de stream via GPT-4o-mini avec deux modes :
- **Mode Normal** &mdash; Titres pour n'importe quel jeu, avec choix d'ambiance et de contexte
- **Mode RP** &mdash; Titres immersifs pour le roleplay (serveur, personnage, episode). Le nom du serveur apparait toujours en premier

**Systeme de Presets** &mdash; Sauvegarde tes configurations favorites et partage-les avec un code a 6 caracteres.

**Favoris & Votes** &mdash; Sauvegarde tes meilleurs titres avec une etoile, note chaque titre avec un pouce haut/bas, et exporte tes favoris en fichier TXT.

**Partage de titres** &mdash; Partage tes meilleurs titres via un code unique a 6 caracteres.

**Classement communautaire** &mdash; Podium anime avec le top des generateurs, classement en temps reel accessible depuis la barre utilisateur.

**Compteur de caracteres** &mdash; Chaque titre affiche son nombre de caracteres (limite 140 pour Twitch).

**Instructions personnalisees** &mdash; Ajoute tes propres directives au generateur pour personnaliser les resultats.

**Regeneration partielle** &mdash; Regenere un seul titre sans relancer toute la generation.

**Authentification Discord** &mdash; Connexion via OAuth2 ouverte a tout utilisateur Discord (email, avatar, banniere recuperes).

**Moderation automatique** &mdash; Chaque requete de generation est analysee par ChatGPT avant execution :
- Detection de contenu inapproprie (insultes, figures haineuses, ideologies extremistes, etc.)
- Avertissement automatique de l'utilisateur en cas d'infraction
- Auto-ban permanent au 3e avertissement
- Notification Discord en temps reel (webhook rouge + ping role)
- Staff (admins + moderateurs) exempts de la moderation

**Panel Admin** &mdash; Gestion complete depuis l'interface :
- Mode maintenance (temps reel via SSE)
- Systeme de bans (temporaires / permanents)
- Systeme de warns (manuels + automatiques, avec tracabilite de l'auteur)
- Recherche utilisateur par ID Discord (profil, email, banniere, token)
- Suppression d'historique
- Forcer un utilisateur ou tous les utilisateurs a rejoindre un serveur Discord
- Deconnexion de toutes les sessions utilisateurs
- Systeme d'annonces (info, alerte, succes) en temps reel
- Dashboard statistiques (generations, titres, utilisateurs actifs sur 7 jours)
- Journal d'activite admin (toutes les actions tracees)
- Reset classement (global ou individuel)

**Panel Moderateur** &mdash; Interface dediee aux moderateurs (role Discord configurable) :
- Recherche utilisateur par ID Discord
- Bans temporaires (pas de ban permanent)
- Systeme de warns manuels
- Pas d'acces au deban, suppression de warns, maintenance, patchnotes

**Patchnotes** &mdash; Systeme de notes de mise a jour avec publication programmee, tags, et notifications temps reel.

**Logs Discord** &mdash; Chaque generation est loguee via webhook dans un salon Discord. Les avertissements automatiques sont envoyes dans un embed rouge avec mention du role de moderation.

**Bot Discord** &mdash; Embed de statut en temps reel dans un salon Discord configurable (online, maintenance, statistiques).

<br>

## Stack technique

| Couche | Technologie |
|--------|------------|
| Backend | **Node.js** + **Express** |
| IA | **OpenAI API** (GPT-4o-mini) &mdash; generation + moderation |
| Auth | **Discord OAuth2** |
| Bot | **Discord.js** (embed de statut) |
| Sessions | express-session + session-file-store |
| Temps reel | Server-Sent Events (SSE) |
| Stockage | Fichiers JSON (userdata, bans, warns, presets, patchnotes, stats, logs) |
| Frontend | HTML / CSS / JS vanilla |

<br>

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- Une application Discord (OAuth2) avec les scopes : `identify`, `email`, `guilds.join`, `guilds.members.read`
- Un bot Discord (pour le statut embed et la fonctionnalite "forcer rejoindre un serveur")
- Une cle API OpenAI

### 1. Clone le repo

```bash
git clone https://github.com/TimeZoneFR/AI-Title
cd AI-Title
```

### 2. Installe les dependances

```bash
npm install
```

### 3. Configure les variables d'environnement

Cree un fichier `.env` a la racine :

```env
OPENAI_API_KEY=sk-...
DISCORD_CLIENT_ID=ton_client_id
DISCORD_CLIENT_SECRET=ton_client_secret
DISCORD_REDIRECT_URI=http://localhost:3000/auth/discord/callback
REQUIRED_GUILD_ID=id_du_serveur (optionnel, pour detection roles moderateurs)
MODERATOR_ROLE_ID=id_du_role_moderateur
DISCORD_BOT_TOKEN=token_du_bot_discord
DISCORD_STATUS_CHANNEL_ID=id_du_salon_pour_embed_statut
SESSION_SECRET=une_chaine_secrete_aleatoire
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
PORT=3000
```

### 4. Lance le serveur

```bash
npm start
```

Le serveur demarre sur `http://localhost:3000`

<br>

## Architecture

```
.
├── server.js              # Serveur Express (API + auth + admin + bot)
├── public/
│   ├── index.html         # Interface utilisateur (SPA)
│   ├── style.css          # Styles (theme sombre + glow orange)
│   └── logo.png           # Logo de l'application
├── userdata/              # Donnees utilisateur (1 fichier JSON par user)
├── sessions/              # Sessions Express (file-store)
├── bans.json              # Liste des bans actifs
├── warns.json             # Liste des avertissements
├── patchnotes.json        # Notes de mise a jour
├── shared-presets.json    # Presets partages (codes)
├── shared-titles.json     # Titres partages (codes)
├── announcement.json      # Annonce active
├── admin-logs.json        # Journal d'activite admin
├── stats.json             # Statistiques globales
├── maintenance.json       # Etat du mode maintenance
├── .env                   # Variables d'environnement (non versionne)
└── package.json
```

<br>

## API Endpoints

<details>
<summary><strong>Auth</strong></summary>

| Methode | Route | Description |
|---------|-------|-------------|
| `GET` | `/auth/discord` | Redirige vers Discord OAuth2 |
| `GET` | `/auth/discord/callback` | Callback OAuth2 |
| `GET` | `/auth/me` | Infos utilisateur connecte |
| `GET` | `/auth/logout` | Deconnexion |

</details>

<details>
<summary><strong>API</strong></summary>

| Methode | Route | Description |
|---------|-------|-------------|
| `POST` | `/api/generate` | Genere des titres via OpenAI |
| `GET` | `/api/userdata` | Recupere les donnees utilisateur |
| `POST` | `/api/userdata` | Sauvegarde les donnees utilisateur |
| `POST` | `/api/presets/share` | Partage un preset (retourne un code) |
| `GET` | `/api/presets/import/:code` | Importe un preset via code |
| `POST` | `/api/titles/share` | Partage un titre (retourne un code) |
| `GET` | `/api/titles/shared/:code` | Recupere un titre partage |
| `GET` | `/api/leaderboard` | Classement des generateurs |
| `GET` | `/api/announcement` | Annonce active (public) |
| `GET` | `/api/patchnotes` | Liste des patchnotes |
| `GET` | `/api/events` | Flux SSE (temps reel) |
| `GET` | `/api/status` | Statut maintenance (public) |

</details>

<details>
<summary><strong>Admin</strong></summary>

| Methode | Route | Description |
|---------|-------|-------------|
| `GET/POST` | `/admin/maintenance` | Gestion mode maintenance |
| `POST` | `/admin/announcement` | Gestion des annonces |
| `GET` | `/admin/user/:id` | Recherche utilisateur |
| `GET` | `/admin/users` | Liste de tous les utilisateurs |
| `GET` | `/admin/bans` | Liste des bans |
| `POST` | `/admin/ban` | Bannir un utilisateur |
| `POST` | `/admin/unban` | Debannir |
| `POST` | `/admin/clear-history` | Supprimer l'historique d'un user |
| `GET` | `/admin/warns` | Liste des warns |
| `POST` | `/admin/warn` | Avertir un utilisateur |
| `POST` | `/admin/unwarn` | Retirer un warn |
| `POST` | `/admin/clear-warns` | Supprimer tous les warns |
| `POST` | `/admin/logout-all` | Deconnecter toutes les sessions |
| `POST` | `/admin/guild-join` | Forcer un utilisateur a rejoindre un serveur |
| `POST` | `/admin/guild-join-all` | Forcer tous les utilisateurs a rejoindre un serveur |
| `POST` | `/admin/patchnotes` | Creer une patchnote |
| `DELETE` | `/admin/patchnotes/:id` | Supprimer une patchnote |
| `POST` | `/admin/leaderboard/reset` | Reset classement global |
| `POST` | `/admin/leaderboard/reset-user` | Reset classement d'un utilisateur |
| `GET` | `/admin/logs` | Journal d'activite admin |
| `GET` | `/admin/stats` | Statistiques globales |

</details>

<br>

## Licence

Projet prive &mdash; Z-Time Studio.

---

<div align="center">
<sub>Fait avec le 🫀 par <strong>Z-Time Studio</strong></sub>
</div>
