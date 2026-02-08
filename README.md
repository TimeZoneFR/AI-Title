<div align="center">

# Stream Generator

### Titres & Notifications Twitch propulses par IA

<br>

<img src="public/logo.png" alt="Logo" width="120">

<br><br>

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?style=for-the-badge&logo=express&logoColor=white)
![OpenAI](https://img.shields.io/badge/OpenAI-GPT--4o--mini-412991?style=for-the-badge&logo=openai&logoColor=white)
![Discord](https://img.shields.io/badge/Discord-OAuth2-5865F2?style=for-the-badge&logo=discord&logoColor=white)

<br>

*Genere des titres de stream uniques et percutants en quelques clics.*
*Authentification Discord, presets partageables, panel admin complet.*

---

</div>

<br>

## Fonctionnalites

**Generation IA** &mdash; Genere des titres de stream via GPT-4o-mini avec deux modes :
- **Mode Normal** &mdash; Titres pour n'importe quel jeu, avec choix d'ambiance et de contexte
- **Mode RP** &mdash; Titres immersifs pour le roleplay (serveur, personnage, episode)

**Systeme de Presets** &mdash; Sauvegarde tes configurations favorites et partage-les avec un code a 6 caracteres.

**Authentification Discord** &mdash; Connexion via OAuth2 avec verification du serveur et du role.

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
- Recherche utilisateur par ID Discord
- Suppression d'historique

**Panel Moderateur** &mdash; Interface dediee aux moderateurs (role Discord configurable) :
- Recherche utilisateur par ID Discord
- Bans temporaires (pas de ban permanent)
- Systeme de warns manuels
- Pas d'acces au deban, suppression de warns, maintenance, patchnotes

**Patchnotes** &mdash; Systeme de notes de mise a jour avec publication programmee et notifications temps reel.

**Logs Discord** &mdash; Chaque generation est loguee via webhook dans un salon Discord. Les avertissements automatiques sont envoyes dans un embed rouge avec mention du role de moderation.

<br>

## Stack technique

| Couche | Technologie |
|--------|------------|
| Backend | **Node.js** + **Express** |
| IA | **OpenAI API** (GPT-4o-mini) &mdash; generation + moderation |
| Auth | **Discord OAuth2** |
| Sessions | express-session + session-file-store |
| Temps reel | Server-Sent Events (SSE) |
| Stockage | Fichiers JSON (userdata, bans, warns, presets, patchnotes) |
| Frontend | HTML / CSS / JS vanilla |

<br>

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- Un serveur Discord avec un bot/application configuree
- Une cle API OpenAI

### 1. Clone le repo

```bash
git clone https://github.com/ton-username/stream-generator.git
cd stream-generator
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
REQUIRED_GUILD_ID=id_du_serveur
REQUIRED_ROLE_ID=id_du_role
SESSION_SECRET=une_chaine_secrete_aleatoire
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
MODERATOR_ROLE_ID=id_du_role_moderateur
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
├── server.js              # Serveur Express (API + auth + admin)
├── public/
│   ├── index.html         # Interface utilisateur (SPA)
│   ├── style.css          # Styles (theme sombre + glow violet)
│   └── logo.png           # Logo de l'application
├── userdata/              # Donnees utilisateur (1 fichier JSON par user)
├── sessions/              # Sessions Express (file-store)
├── bans.json              # Liste des bans actifs
├── warns.json             # Liste des avertissements
├── patchnotes.json        # Notes de mise a jour
├── shared-presets.json    # Presets partages (codes)
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
| `GET` | `/api/patchnotes` | Liste des patchnotes |
| `GET` | `/api/events` | Flux SSE (temps reel) |
| `GET` | `/api/status` | Statut maintenance (public) |

</details>

<details>
<summary><strong>Admin</strong></summary>

| Methode | Route | Description |
|---------|-------|-------------|
| `GET/POST` | `/admin/maintenance` | Gestion mode maintenance |
| `GET` | `/admin/user/:id` | Recherche utilisateur |
| `GET` | `/admin/bans` | Liste des bans |
| `POST` | `/admin/ban` | Bannir un utilisateur |
| `POST` | `/admin/unban` | Debannir |
| `POST` | `/admin/clear-history` | Supprimer l'historique d'un user |
| `GET` | `/admin/warns` | Liste des warns |
| `POST` | `/admin/warn` | Avertir un utilisateur |
| `POST` | `/admin/unwarn` | Retirer un warn |
| `POST` | `/admin/clear-warns` | Supprimer tous les warns |
| `POST` | `/admin/patchnotes` | Creer une patchnote |
| `DELETE` | `/admin/patchnotes/:id` | Supprimer une patchnote |

</details>

<br>

## Licence

Projet prive &mdash; Z-Time Studio.

---

<div align="center">
<sub>Fait avec le 🫀 par <strong>Z-Time Studio</strong></sub>
</div>
