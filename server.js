require('dotenv').config();
const http = require('http');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const cookieMod = require('cookie');
const cookieSig = require('cookie-signature');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const app = express();
const server = http.createServer(app);
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// --- Config ---
const {
    OPENAI_API_KEY,
    DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET,
    DISCORD_REDIRECT_URI,
    REQUIRED_GUILD_ID,
    SESSION_SECRET,
    DISCORD_WEBHOOK_URL,
    MODERATOR_ROLE_ID,
    MEMBER_ROLE_ID,
    PARTNER_ROLE_ID,
    DISCORD_BOT_TOKEN,
    DISCORD_STATUS_CHANNEL_ID
} = process.env;

const ADMIN_DISCORD_ID = '1148249755458228286';
const DAILY_TITLE_LIMIT = 20;
const MEMBER_DAILY_LIMIT = 30;

const MAINTENANCE_FILE = path.join(__dirname, 'maintenance.json');

function loadMaintenance() {
    try {
        if (fs.existsSync(MAINTENANCE_FILE)) {
            const data = JSON.parse(fs.readFileSync(MAINTENANCE_FILE, 'utf8'));
            return !!data.enabled;
        }
    } catch (err) {
        console.error('Erreur lecture maintenance.json:', err.message);
    }
    return false;
}

function saveMaintenance(enabled) {
    try {
        fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify({ enabled }), 'utf8');
    } catch (err) {
        console.error('Erreur ecriture maintenance.json:', err.message);
    }
}

let maintenanceMode = loadMaintenance();

// --- Stats (compteur global de generations) ---
const STATS_FILE = path.join(__dirname, 'stats.json');

function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        }
    } catch (err) {
        console.error('Erreur lecture stats.json:', err.message);
    }
    return { totalGenerations: 0, totalTitles: 0, statusMessageId: null };
}

function saveStats(data) {
    try {
        fs.writeFileSync(STATS_FILE, JSON.stringify(data), 'utf8');
    } catch (err) {
        console.error('Erreur ecriture stats.json:', err.message);
    }
}

let stats = loadStats();

// --- Discord Bot ---
const discordBot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers] });
let botReady = false;

async function sendStatusEmbed(status) {
    if (!botReady || !DISCORD_STATUS_CHANNEL_ID) return;
    const channel = discordBot.channels.cache.get(DISCORD_STATUS_CHANNEL_ID);
    if (!channel) {
        console.error('Salon Discord introuvable:', DISCORD_STATUS_CHANNEL_ID);
        return;
    }

    const isOnline = status === 'online';
    const embed = new EmbedBuilder()
        .setTitle(isOnline ? 'Serveur en ligne' : 'Serveur en maintenance')
        .setDescription(isOnline
            ? 'Le service IA-Title est operationnel.'
            : 'Le service est temporairement indisponible.')
        .setColor(isOnline ? 0x22c55e : 0xf97316)
        .addFields(
            { name: 'Statut', value: isOnline ? '🟢 En ligne' : '🔴 En maintenance', inline: true },
            { name: 'Generations', value: `${stats.totalGenerations}`, inline: true },
            { name: 'Titres generes', value: `${stats.totalTitles || 0}`, inline: true }
        )
        .setFooter({ text: 'IA-Title — Z-Time Studio' })
        .setTimestamp();

    // Si un message existant est stocke, on l'edite
    if (stats.statusMessageId) {
        try {
            const existingMsg = await channel.messages.fetch(stats.statusMessageId);
            await existingMsg.edit({ embeds: [embed] });
            return;
        } catch (err) {
            // Message introuvable (supprime, etc.) → on en envoie un nouveau
            console.log('Ancien embed introuvable, envoi d\'un nouveau.');
        }
    }

    // Envoyer un nouveau message et stocker son ID
    try {
        const msg = await channel.send({ embeds: [embed] });
        stats.statusMessageId = msg.id;
        saveStats(stats);
    } catch (err) {
        console.error('Erreur envoi embed statut:', err.message);
    }
}

discordBot.once('ready', () => {
    botReady = true;
    console.log(`Bot Discord connecte: ${discordBot.user.tag}`);
    sendStatusEmbed(maintenanceMode ? 'maintenance' : 'online');
});

discordBot.on('error', err => {
    console.error('Erreur bot Discord:', err.message);
});

// --- Bans ---
const BANS_FILE = path.join(__dirname, 'bans.json');

function loadBans() {
    try {
        if (fs.existsSync(BANS_FILE)) {
            return JSON.parse(fs.readFileSync(BANS_FILE, 'utf8'));
        }
    } catch (err) {
        console.error('Erreur lecture bans.json:', err.message);
    }
    return {};
}

function saveBans(bans) {
    try {
        fs.writeFileSync(BANS_FILE, JSON.stringify(bans, null, 2), 'utf8');
    } catch (err) {
        console.error('Erreur ecriture bans.json:', err.message);
    }
}

function isUserBanned(userId) {
    const bans = loadBans();
    const ban = bans[userId];
    if (!ban) return false;
    if (ban.permanent) return true;
    if (ban.until && new Date(ban.until) > new Date()) return true;
    // Ban expire -> supprimer
    if (ban.until && new Date(ban.until) <= new Date()) {
        delete bans[userId];
        saveBans(bans);
        return false;
    }
    return false;
}

// --- Warns ---
const WARNS_FILE = path.join(__dirname, 'warns.json');

function loadWarns() {
    try {
        if (fs.existsSync(WARNS_FILE)) {
            return JSON.parse(fs.readFileSync(WARNS_FILE, 'utf8'));
        }
    } catch (err) {
        console.error('Erreur lecture warns.json:', err.message);
    }
    return {};
}

function saveWarns(warns) {
    try {
        fs.writeFileSync(WARNS_FILE, JSON.stringify(warns, null, 2), 'utf8');
    } catch (err) {
        console.error('Erreur ecriture warns.json:', err.message);
    }
}

function getUserWarns(userId) {
    const warns = loadWarns();
    return warns[userId] || [];
}

function addAutoWarn(userId, reason) {
    if (userId === ADMIN_DISCORD_ID) return null;
    const warns = loadWarns();
    if (!warns[userId]) warns[userId] = [];
    const warn = {
        id: Date.now(),
        reason,
        date: new Date().toISOString(),
        auto: true
    };
    warns[userId].push(warn);
    saveWarns(warns);
    console.log(`Auto-warn: ${userId} - Raison: ${reason} (Total: ${warns[userId].length})`);
    return { warn, total: warns[userId].length };
}

// --- Content Moderation via ChatGPT ---
async function checkContentModeration(userPrompt, meta) {
    try {
        const textToCheck = [
            meta?.game || '',
            meta?.character || '',
            meta?.mood || '',
            userPrompt
        ].join(' ');

        const isRP = meta?.mode === 'rp';

        const rpException = isRP ? `

Contenu AUTORISE en mode RP (ne PAS flag) :
- References aux addictions, drogues, alcool, substances (drogue, came, coke, meth, deal, trafic, addiction, overdose, rehab, alcool, joint, beuh, shit, etc.)
- Ces themes sont des elements narratifs courants en GTA RP et ne doivent PAS etre consideres comme inappropries dans ce contexte.` : '';

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: `Tu es un moderateur de contenu. Analyse le texte fourni et determine s'il contient du contenu inapproprie.${isRP ? ' Le texte provient d\'un contexte de roleplay GTA RP.' : ''}

Contenu INTERDIT :
- Noms de dictateurs, criminels de guerre, figures haineuses (Hitler, Staline, Mussolini, Pol Pot, etc.)
- Insultes, vulgarites, gros mots (fdp, ntm, nique, merde, putain, connard, salope, pd, etc.)
- Contenu raciste, sexiste, homophobe, discriminatoire
- References au nazisme, fascisme, terrorisme, ideologies extremistes
- Contenu sexuel ou pornographique
- Incitation a la violence ou a la haine
- Harcelement, menaces
- Tout contenu inapproprie pour un service tout public${rpException}

Reponds UNIQUEMENT par un JSON strict :
{"flagged": true/false, "reason": "raison courte si flagged, sinon vide"}

Sois strict : au moindre doute, flag le contenu.`
                    },
                    {
                        role: 'user',
                        content: `Analyse ce texte : "${textToCheck}"`
                    }
                ],
                temperature: 0,
                max_tokens: 100
            })
        });

        if (!response.ok) return { flagged: false, reason: '' };

        const data = await response.json();
        const content = data.choices[0].message.content.trim();
        const result = JSON.parse(content);
        return { flagged: !!result.flagged, reason: result.reason || 'Contenu inapproprie' };
    } catch (err) {
        console.error('Erreur moderation:', err.message);
        return { flagged: false, reason: '' };
    }
}

// --- Webhook warn auto (rouge + ping role) ---
function sendWarnWebhook(user, reason, totalWarns, meta) {
    if (!DISCORD_WEBHOOK_URL) return;

    const fields = [
        { name: 'Utilisateur', value: `${user.username} (\`${user.id}\`)`, inline: true },
        { name: 'Warns', value: `${totalWarns}/3`, inline: true },
        { name: 'Raison', value: reason },
        { name: 'Mode', value: meta?.mode === 'rp' ? 'RP' : 'Normal', inline: true },
        { name: meta?.mode === 'rp' ? 'Serveur' : 'Jeu', value: meta?.game || 'Non specifie', inline: true }
    ];

    if (meta?.mode === 'rp') {
        if (meta.character) fields.push({ name: 'Personnage', value: meta.character, inline: true });
        if (meta.mood) fields.push({ name: 'Ambiance', value: meta.mood, inline: true });
        if (meta.rpContext) fields.push({ name: 'Contexte RP', value: meta.rpContext.substring(0, 200) });
        if (meta.rpEpisode) fields.push({ name: 'Episode', value: `#${meta.rpEpisode}`, inline: true });
        if (meta.rpInstructions) fields.push({ name: 'Instructions custom', value: meta.rpInstructions.substring(0, 200) });
    } else {
        if (meta?.mood) fields.push({ name: 'Ambiance', value: meta.mood, inline: true });
        if (meta?.context) fields.push({ name: 'Contexte', value: meta.context.substring(0, 200) });
        if (meta?.customInstructions) fields.push({ name: 'Instructions custom', value: meta.customInstructions.substring(0, 200) });
    }

    const embed = {
        title: '⚠️ Avertissement automatique',
        color: 0xff0000,
        fields,
        timestamp: new Date().toISOString()
    };

    fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            content: '<@&1467477738234446017>',
            embeds: [embed]
        })
    }).catch(err => console.error('Webhook warn error:', err.message));
}

// --- Patchnotes ---
const PATCHNOTES_FILE = path.join(__dirname, 'patchnotes.json');

function loadPatchnotes() {
    try {
        if (fs.existsSync(PATCHNOTES_FILE)) {
            return JSON.parse(fs.readFileSync(PATCHNOTES_FILE, 'utf8'));
        }
    } catch (err) {
        console.error('Erreur lecture patchnotes.json:', err.message);
    }
    return [];
}

function savePatchnotes(patchnotes) {
    try {
        fs.writeFileSync(PATCHNOTES_FILE, JSON.stringify(patchnotes, null, 2), 'utf8');
    } catch (err) {
        console.error('Erreur ecriture patchnotes.json:', err.message);
    }
}

// --- Shared Presets ---
const SHARED_PRESETS_FILE = path.join(__dirname, 'shared-presets.json');

function loadSharedPresets() {
    try {
        if (fs.existsSync(SHARED_PRESETS_FILE)) {
            return JSON.parse(fs.readFileSync(SHARED_PRESETS_FILE, 'utf8'));
        }
    } catch (err) {
        console.error('Erreur lecture shared-presets.json:', err.message);
    }
    return {};
}

function saveSharedPresets(data) {
    try {
        fs.writeFileSync(SHARED_PRESETS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('Erreur ecriture shared-presets.json:', err.message);
    }
}

function generateShareCode() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[bytes[i] % chars.length];
    }
    return code;
}

// --- WebSocket ---
const SERVER_VERSION = Date.now().toString();
const wss = new WebSocketServer({ server, path: '/ws' });

// Tous les clients connectes (pour broadcast global)
const wsAllClients = new Set();
// Par userId (pour messages cibles : ban, warn)
const wsUserClients = new Map();

function getSessionFromRequest(req) {
    try {
        const cookies = cookieMod.parse(req.headers.cookie || '');
        const rawSid = cookies['connect.sid'];
        if (!rawSid) return null;
        const sid = rawSid.startsWith('s:')
            ? cookieSig.unsign(rawSid.slice(2), SESSION_SECRET || 'change-me-in-production')
            : rawSid;
        if (!sid) return null;
        const sessionPath = path.join(__dirname, 'sessions', `${sid}.json`);
        if (fs.existsSync(sessionPath)) {
            return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        }
    } catch {}
    return null;
}

wss.on('connection', (ws, req) => {
    wsAllClients.add(ws);

    let userId = null;
    const sessionData = getSessionFromRequest(req);
    if (sessionData && sessionData.user) {
        userId = sessionData.user.id;
        if (!wsUserClients.has(userId)) wsUserClients.set(userId, new Set());
        wsUserClients.get(userId).add(ws);
    }

    // Envoyer la version du serveur a la connexion (+ etat maintenance actuel)
    ws.send(JSON.stringify({ event: 'version', data: { version: SERVER_VERSION, maintenance: maintenanceMode } }));

    ws.on('close', () => {
        wsAllClients.delete(ws);
        if (userId) {
            const clients = wsUserClients.get(userId);
            if (clients) {
                clients.delete(ws);
                if (clients.size === 0) wsUserClients.delete(userId);
            }
        }
    });

    ws.on('error', () => ws.terminate());
});

function broadcastWS(event, data) {
    const msg = JSON.stringify({ event, data });
    wsAllClients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

function sendToUser(userId, event, data) {
    const clients = wsUserClients.get(userId);
    if (!clients) return;
    const msg = JSON.stringify({ event, data });
    clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

// --- Middleware ---
app.use(express.json());
app.use(session({
    store: new FileStore({
        path: path.join(__dirname, 'sessions'),
        ttl: 7 * 24 * 60 * 60, // 7 jours en secondes
        retries: 0
    }),
    secret: SESSION_SECRET || 'change-me-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // mettre true si HTTPS en production
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 jours
    }
}));
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }
}));

// Route /admin -> admin.html
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- Auth Middleware ---
function requireAuth(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    return res.status(401).json({ error: 'Non authentifie' });
}

function requireAdmin(req, res, next) {
    if (req.session && req.session.user && req.session.user.id === ADMIN_DISCORD_ID) {
        return next();
    }
    return res.status(403).json({ error: 'Acces refuse' });
}

function isStaff(user) {
    if (!user) return false;
    if (user.id === ADMIN_DISCORD_ID) return true;
    if (MODERATOR_ROLE_ID && user.roles && user.roles.includes(MODERATOR_ROLE_ID)) return true;
    return false;
}

function isPartner(user) {
    if (!user) return false;
    return PARTNER_ROLE_ID && user.roles && user.roles.includes(PARTNER_ROLE_ID);
}

function hasUnlimitedGenerations(user) {
    return isStaff(user) || isPartner(user);
}

function isMember(user) {
    if (!user) return false;
    return MEMBER_ROLE_ID && user.roles && user.roles.includes(MEMBER_ROLE_ID);
}

function getUserDailyLimit(user) {
    if (hasUnlimitedGenerations(user)) return Infinity;
    if (isMember(user)) return MEMBER_DAILY_LIMIT;
    return DAILY_TITLE_LIMIT;
}

// Recupere les roles d'un membre via le Bot token (fiable, pas d'expiration)
async function fetchMemberRoles(userId) {
    if (!REQUIRED_GUILD_ID || !DISCORD_BOT_TOKEN) return null;
    try {
        const memberRes = await fetch(
            `https://discord.com/api/guilds/${REQUIRED_GUILD_ID}/members/${userId}`,
            { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
        );
        if (memberRes.ok) {
            const member = await memberRes.json();
            return member.roles || [];
        } else {
            console.error(`[ROLES] Erreur ${memberRes.status} pour ${userId}`);
        }
    } catch (err) {
        console.error(`[ROLES] Fetch failed pour ${userId}:`, err.message);
    }
    return null;
}

function getUserDailyCredits(userId) {
    const filePath = getUserDataPath(userId);
    try {
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const today = new Date().toISOString().slice(0, 10);
            if (data._creditsDate === today) {
                return data._creditsUsed || 0;
            }
        }
    } catch {}
    return 0;
}

function addUserDailyCredits(userId, count) {
    const filePath = getUserDataPath(userId);
    try {
        let data = {};
        if (fs.existsSync(filePath)) {
            data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        const today = new Date().toISOString().slice(0, 10);
        if (data._creditsDate !== today) {
            data._creditsDate = today;
            data._creditsUsed = 0;
        }
        data._creditsUsed = (data._creditsUsed || 0) + count;
        fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
        return data._creditsUsed;
    } catch {}
    return 0;
}

function requireStaff(req, res, next) {
    if (req.session && req.session.user && isStaff(req.session.user)) {
        return next();
    }
    return res.status(403).json({ error: 'Acces refuse' });
}

function checkBan(req, res, next) {
    if (req.session && req.session.user) {
        if (isUserBanned(req.session.user.id)) {
            const bans = loadBans();
            const ban = bans[req.session.user.id];
            return res.status(403).json({
                error: 'banned',
                reason: ban.reason || '',
                permanent: !!ban.permanent,
                until: ban.until || null
            });
        }
    }
    return next();
}

function checkMaintenance(req, res, next) {
    if (!maintenanceMode) return next();
    // Staff (admin + moderateurs) can always access
    if (req.session && req.session.user && isStaff(req.session.user)) {
        return next();
    }
    return res.status(503).json({ error: 'maintenance' });
}

// --- Discord OAuth2 Routes ---

// Step 1: Redirect to Discord
app.get('/auth/discord', (req, res) => {
    const params = new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        redirect_uri: DISCORD_REDIRECT_URI,
        response_type: 'code',
        scope: 'identify email guilds.join guilds.members.read'
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// Step 2: Handle callback
app.get('/auth/discord/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.redirect('/?error=auth_failed');
    }

    try {
        // Exchange code for token
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: DISCORD_REDIRECT_URI
            })
        });

        if (!tokenRes.ok) {
            console.error('Token exchange failed:', await tokenRes.text());
            return res.redirect('/?error=auth_failed');
        }

        const tokenData = await tokenRes.json();
        const accessToken = tokenData.access_token;

        // Get user info
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!userRes.ok) {
            console.error('User fetch failed:', await userRes.text());
            return res.redirect('/?error=auth_failed');
        }

        const user = await userRes.json();

        // Check if user is banned
        if (isUserBanned(user.id)) {
            return res.redirect('/?error=banned');
        }

        // Fetch guild roles via Bot token (fiable)
        const fetchedRoles = await fetchMemberRoles(user.id);
        const roles = fetchedRoles || [];

        // Create session with extended user data
        req.session.user = {
            id: user.id,
            username: user.username,
            discriminator: user.discriminator || '0',
            avatar: user.avatar,
            email: user.email || null,
            banner: user.banner || null,
            banner_color: user.banner_color || null,
            roles,
            accessToken
        };

        // Save user profile to userdata for admin lookups
        try {
            const udPath = getUserDataPath(user.id);
            let ud = { presets: [], titleHistory: [], lastReadPatchnote: 0 };
            if (fs.existsSync(udPath)) {
                ud = JSON.parse(fs.readFileSync(udPath, 'utf8'));
            }
            ud.profile = {
                username: user.username,
                avatar: user.avatar,
                email: user.email || null,
                banner: user.banner || null,
                banner_color: user.banner_color || null,
                lastLogin: new Date().toISOString()
            };
            ud.accessToken = accessToken;
            if (!ud.firstSeen) ud.firstSeen = new Date().toISOString();
            fs.writeFileSync(udPath, JSON.stringify(ud), 'utf8');
        } catch (err) {
            console.error('Erreur sauvegarde profil:', err.message);
        }

        res.redirect('/');

    } catch (err) {
        console.error('Auth error:', err);
        res.redirect('/?error=auth_failed');
    }
});

// Get current user
app.get('/auth/me', async (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (req.session && req.session.user) {
        // Refresh roles via Bot token
        const freshRoles = await fetchMemberRoles(req.session.user.id);
        if (freshRoles) req.session.user.roles = freshRoles;

        const banned = isUserBanned(req.session.user.id);
        const banInfo = banned ? loadBans()[req.session.user.id] : null;
        const userWarns = getUserWarns(req.session.user.id);
        const isModerator = MODERATOR_ROLE_ID && req.session.user.roles && req.session.user.roles.includes(MODERATOR_ROLE_ID);
        const memberCheck = !!isMember(req.session.user);
        const partnerCheck = !!isPartner(req.session.user);
        const dailyLimit = getUserDailyLimit(req.session.user);
        console.log(`[DEBUG /auth/me] user=${req.session.user.username} roles=${JSON.stringify(req.session.user.roles)} MEMBER_ROLE_ID=${MEMBER_ROLE_ID} isMember=${memberCheck} isPartner=${partnerCheck} dailyLimit=${dailyLimit}`);
        const { accessToken, ...safeUser } = req.session.user;
        const responseData = {
            ...safeUser,
            isAdmin: req.session.user.id === ADMIN_DISCORD_ID,
            isModerator: !!isModerator,
            isStaff: req.session.user.id === ADMIN_DISCORD_ID || !!isModerator,
            isPartner: partnerCheck,
            isMember: memberCheck,
            unlimitedGenerations: hasUnlimitedGenerations(req.session.user),
            creditsUsed: hasUnlimitedGenerations(req.session.user) ? 0 : getUserDailyCredits(req.session.user.id),
            creditsMax: dailyLimit,
            maintenance: maintenanceMode,
            banned,
            banInfo,
            warns: userWarns
        };
        console.log(`[DEBUG /auth/me] response.isMember=${responseData.isMember} response.creditsMax=${responseData.creditsMax}`);
        return res.json(responseData);
    }
    res.status(401).json({ error: 'Non authentifie' });
});

// Logout
app.get('/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ ok: true });
    });
});

// --- Maintenance Status (public) ---
app.get('/api/status', (req, res) => {
    res.json({ maintenance: maintenanceMode });
});

// --- User Data (persistance par compte Discord) ---
const USERDATA_DIR = path.join(__dirname, 'userdata');
if (!fs.existsSync(USERDATA_DIR)) fs.mkdirSync(USERDATA_DIR);

function getUserDataPath(userId) {
    return path.join(USERDATA_DIR, `${userId}.json`);
}

app.get('/api/userdata', requireAuth, checkBan, (req, res) => {
    const filePath = getUserDataPath(req.session.user.id);
    try {
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return res.json(data);
        }
    } catch (err) {
        console.error('Erreur lecture userdata:', err.message);
    }
    res.json({ presets: [], titleHistory: [] });
});

app.post('/api/userdata', requireAuth, checkBan, (req, res) => {
    const { presets, titleHistory, lastReadPatchnote } = req.body;
    const filePath = getUserDataPath(req.session.user.id);

    // Lire les donnees existantes pour conserver profile et firstSeen
    let existing = {};
    try {
        if (fs.existsSync(filePath)) {
            existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch {}

    const data = {
        ...existing,
        presets: (presets || []).slice(0, 20),
        titleHistory: (titleHistory || []).slice(0, 20),
        lastReadPatchnote: lastReadPatchnote || 0
    };
    try {
        fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
        res.json({ ok: true });
    } catch (err) {
        console.error('Erreur ecriture userdata:', err.message);
        res.status(500).json({ error: 'Erreur sauvegarde donnees' });
    }
});

// --- Preset Sharing ---
app.post('/api/presets/share', requireAuth, checkBan, (req, res) => {
    const { preset, presetId } = req.body;
    if (!preset || !preset.name) {
        return res.status(400).json({ error: 'Preset invalide' });
    }

    const sanitized = {
        name: (preset.name || '').slice(0, 100),
        mode: preset.mode === 'rp' ? 'rp' : 'normal',
        game: (preset.game || '').slice(0, 200),
        mood: (preset.mood || 'fun').slice(0, 50),
        customMood: (preset.customMood || '').slice(0, 200),
        context: (preset.context || '').slice(0, 500),
        titleCount: ['3', '5', '10'].includes(preset.titleCount) ? preset.titleCount : '5',
        rpServer: (preset.rpServer || '').slice(0, 200),
        rpCharacter: (preset.rpCharacter || '').slice(0, 200),
        rpEpisode: (preset.rpEpisode || '').slice(0, 10),
        rpMood: (preset.rpMood || 'immersif').slice(0, 50),
        rpCustomMood: (preset.rpCustomMood || '').slice(0, 200),
        rpContext: (preset.rpContext || '').slice(0, 500),
        rpTitleCount: ['3', '5', '10'].includes(preset.rpTitleCount) ? preset.rpTitleCount : '5'
    };

    const shared = loadSharedPresets();

    // Verifier si ce preset a deja un code
    if (presetId) {
        const existing = Object.values(shared).find(s => s.sharedBy === req.session.user.id && s.presetId === presetId);
        if (existing) {
            // Mettre a jour le preset avec les donnees actuelles
            shared[existing.code].preset = sanitized;
            saveSharedPresets(shared);
            return res.json({ code: existing.code });
        }
    }

    const userShareCount = Object.values(shared).filter(s => s.sharedBy === req.session.user.id).length;
    if (userShareCount >= 20) {
        return res.status(429).json({ error: 'Limite de partage atteinte (max 20)' });
    }

    let code;
    do {
        code = generateShareCode();
    } while (shared[code]);

    shared[code] = {
        code,
        preset: sanitized,
        presetId: presetId || null,
        sharedBy: req.session.user.id,
        createdAt: new Date().toISOString()
    };

    saveSharedPresets(shared);
    console.log(`Preset partage: ${code} par ${req.session.user.username}`);
    res.json({ code });
});

app.get('/api/presets/import/:code', requireAuth, checkBan, (req, res) => {
    const code = req.params.code.trim().toLowerCase();

    if (!/^[a-z0-9]{6}$/.test(code)) {
        return res.status(400).json({ error: 'Code invalide' });
    }

    const shared = loadSharedPresets();
    const entry = shared[code];

    if (!entry) {
        return res.status(404).json({ error: 'Preset non trouve. Verifie le code.' });
    }

    const userFilePath = getUserDataPath(req.session.user.id);
    let userData = { presets: [] };
    try {
        if (fs.existsSync(userFilePath)) {
            userData = JSON.parse(fs.readFileSync(userFilePath, 'utf8'));
        }
    } catch {}

    if ((userData.presets || []).length >= 20) {
        return res.status(400).json({ error: 'Tu as deja 20 presets (limite max). Supprime-en un avant d\'importer.' });
    }

    res.json({ preset: entry.preset });
});

// --- Admin Routes ---
app.get('/admin/maintenance', requireAdmin, (req, res) => {
    res.json({ maintenance: maintenanceMode });
});

app.post('/admin/maintenance', requireAdmin, (req, res) => {
    const { enabled } = req.body;
    maintenanceMode = !!enabled;
    saveMaintenance(maintenanceMode);
    broadcastWS('maintenance', { enabled: maintenanceMode });
    sendStatusEmbed(maintenanceMode ? 'maintenance' : 'online');
    console.log(`Maintenance mode: ${maintenanceMode ? 'ON' : 'OFF'}`);
    addLog('maintenance', req.session.user, null, maintenanceMode ? 'ON' : 'OFF');
    res.json({ maintenance: maintenanceMode });
});

// --- Admin User Lookup ---
app.get('/admin/user/:id', requireStaff, async (req, res) => {
    const userId = req.params.id.trim();
    const filePath = getUserDataPath(userId);
    const bans = loadBans();
    const ban = bans[userId] || null;
    const isBanned = isUserBanned(userId);

    let userData = null;
    try {
        if (fs.existsSync(filePath)) {
            userData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (err) {
        console.error('Erreur lecture userdata admin:', err.message);
    }

    const userWarns = getUserWarns(userId);

    // Fetch les roles Discord pour calculer la vraie limite
    const roles = await fetchMemberRoles(userId) || [];
    const fakeUser = { id: userId, roles };
    const dailyLimit = getUserDailyLimit(fakeUser);
    const unlimited = hasUnlimitedGenerations(fakeUser);

    // Determiner le role
    let userRole = 'Visiteur';
    if (userId === ADMIN_DISCORD_ID) userRole = 'Admin';
    else if (isStaff(fakeUser)) userRole = 'Moderateur';
    else if (isPartner(fakeUser)) userRole = 'Partenaire';
    else if (isMember(fakeUser)) userRole = 'Membre';

    const today = new Date().toISOString().slice(0, 10);
    const creditsUsed = userData && userData._creditsDate === today ? (userData._creditsUsed || 0) : 0;

    res.json({
        userId,
        exists: !!userData,
        profile: userData?.profile || null,
        firstSeen: userData?.firstSeen || null,
        presetsCount: (userData?.presets || []).length,
        titleHistory: userData?.titleHistory || [],
        banned: isBanned,
        banInfo: isBanned ? ban : null,
        warns: userWarns,
        hasToken: !!userData?.accessToken,
        creditsUsed,
        creditsMax: dailyLimit,
        unlimitedGenerations: unlimited,
        userRole
    });
});

// --- Admin Ban Routes ---
app.get('/admin/bans', requireStaff, (req, res) => {
    const bans = loadBans();
    res.json(bans);
});

app.post('/admin/ban', requireStaff, (req, res) => {
    const { userId, reason, duration, permanent } = req.body;
    if (!userId || !userId.trim()) {
        return res.status(400).json({ error: 'ID utilisateur requis' });
    }

    const cleanId = userId.trim();
    if (cleanId === ADMIN_DISCORD_ID) {
        return res.status(400).json({ error: 'Impossible de bannir un administrateur' });
    }

    // Moderateurs ne peuvent pas ban permanent
    const isAdmin = req.session.user.id === ADMIN_DISCORD_ID;
    if (!isAdmin && permanent) {
        return res.status(403).json({ error: 'Seuls les administrateurs peuvent bannir de facon permanente' });
    }

    const bans = loadBans();
    const ban = {
        reason: reason || '',
        date: new Date().toISOString()
    };

    if (permanent) {
        ban.permanent = true;
    } else if (duration) {
        const until = new Date();
        until.setMinutes(until.getMinutes() + parseInt(duration));
        ban.until = until.toISOString();
    } else {
        return res.status(400).json({ error: 'Duree ou permanent requis' });
    }

    bans[cleanId] = ban;
    saveBans(bans);
    sendToUser(cleanId, 'banned', { reason: ban.reason, permanent: !!ban.permanent, until: ban.until || null });
    console.log(`Ban: ${cleanId} - ${ban.permanent ? 'Permanent' : 'Jusqu\'a ' + ban.until} - Raison: ${ban.reason}`);
    addLog('ban', req.session.user, cleanId, ban.reason);
    res.json({ ok: true, ban });
});

app.post('/admin/unban', requireAdmin, (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'ID utilisateur requis' });

    const bans = loadBans();
    if (!bans[userId]) return res.status(404).json({ error: 'Utilisateur non banni' });

    delete bans[userId];
    saveBans(bans);
    console.log(`Unban: ${userId}`);
    addLog('unban', req.session.user, userId);
    res.json({ ok: true });
});

app.post('/admin/clear-history', requireAdmin, (req, res) => {
    const { userId } = req.body;
    if (!userId || !userId.trim()) {
        return res.status(400).json({ error: 'ID utilisateur requis' });
    }

    const filePath = getUserDataPath(userId.trim());
    try {
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            data.titleHistory = [];
            fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
            console.log(`Historique supprime pour: ${userId.trim()}`);
            addLog('clear-history', req.session.user, userId.trim());
            return res.json({ ok: true });
        }
        return res.status(404).json({ error: 'Aucune donnee trouvee pour cet utilisateur' });
    } catch (err) {
        console.error('Erreur clear history:', err.message);
        return res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.post('/admin/reset-credits', requireAdmin, (req, res) => {
    const { userId } = req.body;
    if (!userId || !userId.trim()) {
        return res.status(400).json({ error: 'ID utilisateur requis' });
    }

    const filePath = getUserDataPath(userId.trim());
    try {
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            data._creditsUsed = 0;
            data._creditsDate = '';
            fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
            addLog('reset-credits', req.session.user, userId.trim());
            return res.json({ ok: true });
        }
        return res.status(404).json({ error: 'Aucune donnee trouvee pour cet utilisateur' });
    } catch (err) {
        console.error('Erreur reset credits:', err.message);
        return res.status(500).json({ error: 'Erreur serveur' });
    }
});

// --- Admin Warn Routes ---
app.get('/admin/warns', requireStaff, (req, res) => {
    const warns = loadWarns();
    res.json(warns);
});

app.post('/admin/warn', requireStaff, (req, res) => {
    const { userId, reason } = req.body;
    if (!userId || !userId.trim()) {
        return res.status(400).json({ error: 'ID utilisateur requis' });
    }
    if (!reason || !reason.trim()) {
        return res.status(400).json({ error: 'Raison requise pour un avertissement' });
    }

    const cleanId = userId.trim();
    if (cleanId === ADMIN_DISCORD_ID) {
        return res.status(400).json({ error: 'Impossible de warn un administrateur' });
    }

    const warns = loadWarns();
    if (!warns[cleanId]) warns[cleanId] = [];

    const warn = {
        id: Date.now(),
        reason: reason.trim(),
        date: new Date().toISOString(),
        by: {
            id: req.session.user.id,
            username: req.session.user.username
        }
    };

    warns[cleanId].push(warn);
    saveWarns(warns);
    sendToUser(cleanId, 'warned', { reason: warn.reason, total: warns[cleanId].length });
    console.log(`Warn: ${cleanId} - Raison: ${warn.reason} (Total: ${warns[cleanId].length})`);
    addLog('warn', req.session.user, cleanId, warn.reason);
    res.json({ ok: true, warn, total: warns[cleanId].length });
});

app.post('/admin/unwarn', requireAdmin, (req, res) => {
    const { userId, warnId } = req.body;
    if (!userId) return res.status(400).json({ error: 'ID utilisateur requis' });

    const warns = loadWarns();
    if (!warns[userId] || warns[userId].length === 0) {
        return res.status(404).json({ error: 'Aucun avertissement pour cet utilisateur' });
    }

    if (warnId) {
        warns[userId] = warns[userId].filter(w => w.id !== warnId);
    } else {
        warns[userId].pop();
    }

    if (warns[userId].length === 0) delete warns[userId];
    saveWarns(warns);
    console.log(`Unwarn: ${userId}${warnId ? ' (warn #' + warnId + ')' : ''}`);
    addLog('unwarn', req.session.user, userId);
    res.json({ ok: true });
});

app.post('/admin/clear-warns', requireAdmin, (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'ID utilisateur requis' });

    const warns = loadWarns();
    delete warns[userId];
    saveWarns(warns);
    console.log(`Clear warns: ${userId}`);
    addLog('clear-warns', req.session.user, userId);
    res.json({ ok: true });
});

// --- Admin Logout All ---
app.post('/admin/logout-all', requireAdmin, (req, res) => {
    const sessionsDir = path.join(__dirname, 'sessions');
    const adminSessionId = req.sessionID;
    try {
        const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
        let count = 0;
        for (const file of files) {
            // Keep the admin's own session
            const sid = file.replace('.json', '');
            if (sid === adminSessionId) continue;
            try {
                fs.unlinkSync(path.join(sessionsDir, file));
                count++;
            } catch {}
        }
        console.log(`Logout all: ${count} sessions supprimees`);
        addLog('logout-all', req.session.user, null, `${count} sessions`);
        res.json({ ok: true, count });
    } catch (err) {
        console.error('Erreur logout all:', err.message);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// --- Admin Guild Join Routes ---
app.get('/admin/users', requireAdmin, (req, res) => {
    try {
        const files = fs.readdirSync(USERDATA_DIR).filter(f => f.endsWith('.json'));
        const users = [];
        for (const file of files) {
            const userId = file.replace('.json', '');
            try {
                const data = JSON.parse(fs.readFileSync(path.join(USERDATA_DIR, file), 'utf8'));
                users.push({
                    id: userId,
                    username: data.profile?.username || 'Inconnu',
                    avatar: data.profile?.avatar || null,
                    email: data.profile?.email || null,
                    banner: data.profile?.banner || null,
                    firstSeen: data.firstSeen || null,
                    lastLogin: data.profile?.lastLogin || null,
                    hasToken: !!data.accessToken
                });
            } catch {}
        }
        res.json(users);
    } catch (err) {
        console.error('Erreur listing users:', err.message);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.post('/admin/guild-join', requireAdmin, async (req, res) => {
    const { userId, guildId } = req.body;
    if (!userId || !guildId) {
        return res.status(400).json({ error: 'userId et guildId requis' });
    }
    if (!DISCORD_BOT_TOKEN) {
        return res.status(500).json({ error: 'DISCORD_BOT_TOKEN non configure' });
    }

    // Get user's access token from userdata
    const udPath = getUserDataPath(userId.trim());
    let accessToken = null;
    try {
        if (fs.existsSync(udPath)) {
            const ud = JSON.parse(fs.readFileSync(udPath, 'utf8'));
            accessToken = ud.accessToken;
        }
    } catch {}

    if (!accessToken) {
        return res.status(400).json({ error: 'Aucun token disponible pour cet utilisateur. Il doit se reconnecter.' });
    }

    try {
        const joinRes = await fetch(`https://discord.com/api/guilds/${guildId}/members/${userId.trim()}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ access_token: accessToken })
        });

        if (joinRes.status === 201) {
            return res.json({ ok: true, status: 'added', message: 'Utilisateur ajoute au serveur' });
        } else if (joinRes.status === 204) {
            return res.json({ ok: true, status: 'already_member', message: 'Utilisateur deja membre du serveur' });
        } else {
            const err = await joinRes.text();
            console.error(`Guild join failed (${joinRes.status}):`, err);
            return res.status(joinRes.status).json({ error: `Echec: ${joinRes.status}. Le token a peut-etre expire.` });
        }
    } catch (err) {
        console.error('Erreur guild join:', err.message);
        return res.status(500).json({ error: 'Erreur de connexion a Discord' });
    }
});

app.post('/admin/guild-join-all', requireAdmin, async (req, res) => {
    const { guildId } = req.body;
    if (!guildId) {
        return res.status(400).json({ error: 'guildId requis' });
    }
    if (!DISCORD_BOT_TOKEN) {
        return res.status(500).json({ error: 'DISCORD_BOT_TOKEN non configure' });
    }

    const files = fs.readdirSync(USERDATA_DIR).filter(f => f.endsWith('.json'));
    let added = 0, alreadyMember = 0, failed = 0, noToken = 0;

    for (const file of files) {
        const userId = file.replace('.json', '');
        let accessToken = null;
        try {
            const ud = JSON.parse(fs.readFileSync(path.join(USERDATA_DIR, file), 'utf8'));
            accessToken = ud.accessToken;
        } catch {}

        if (!accessToken) { noToken++; continue; }

        try {
            const joinRes = await fetch(`https://discord.com/api/guilds/${guildId}/members/${userId}`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ access_token: accessToken })
            });

            if (joinRes.status === 201) added++;
            else if (joinRes.status === 204) alreadyMember++;
            else failed++;

            // Rate limit: small delay between requests
            await new Promise(r => setTimeout(r, 500));
        } catch {
            failed++;
        }
    }

    console.log(`Guild join all (${guildId}): ${added} ajoutes, ${alreadyMember} deja membres, ${failed} echecs, ${noToken} sans token`);
    res.json({ ok: true, added, alreadyMember, failed, noToken, total: files.length });
});

// --- Patchnotes Routes ---
app.get('/api/patchnotes', requireAuth, (req, res) => {
    const all = loadPatchnotes();
    const isAdmin = req.session.user && req.session.user.id === ADMIN_DISCORD_ID;
    if (isAdmin) return res.json(all);
    res.json(all.filter(p => p.published !== false));
});

app.post('/admin/patchnotes', requireAdmin, express.json(), (req, res) => {
    const { title, content, tags, scheduledAt } = req.body;
    if (!title || !content) {
        return res.status(400).json({ error: 'Titre et contenu requis' });
    }

    let parsedTags = [];
    try { parsedTags = Array.isArray(tags) ? tags : (tags ? JSON.parse(tags) : []); } catch { parsedTags = []; }

    const scheduled = scheduledAt ? new Date(scheduledAt) : null;
    const isScheduled = scheduled && scheduled > new Date();

    const newNote = {
        id: Date.now(),
        title,
        content,
        date: new Date().toISOString(),
        tags: parsedTags,
        scheduledAt: isScheduled ? scheduled.toISOString() : null,
        published: !isScheduled
    };

    const patchnotes = loadPatchnotes();
    patchnotes.unshift(newNote);
    savePatchnotes(patchnotes);

    if (newNote.published) {
        broadcastWS('patchnote', newNote);
    }

    console.log(`Nouvelle patchnote: ${title}${isScheduled ? ' (programmee)' : ''}`);
    res.json(newNote);
});

app.delete('/admin/patchnotes/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    let patchnotes = loadPatchnotes();
    patchnotes = patchnotes.filter(p => p.id !== id);
    savePatchnotes(patchnotes);
    res.json({ ok: true });
});

// --- Discord Webhook Logs ---
function sendGenerationLog(user, meta, titles) {
    if (!DISCORD_WEBHOOK_URL) return;

    const modeLabel = meta.mode === 'rp' ? 'RP' : 'Normal';
    const titlesList = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');

    const embed = {
        title: `Generation de titres`,
        color: meta.mode === 'rp' ? 0xff6b35 : 0x9147ff,
        fields: [
            { name: 'Utilisateur', value: `${user.username} (\`${user.id}\`)`, inline: true },
            { name: 'Mode', value: modeLabel, inline: true },
            { name: meta.mode === 'rp' ? 'Serveur' : 'Jeu', value: meta.game || 'Non specifie', inline: true },
        ],
        timestamp: new Date().toISOString()
    };

    if (meta.mode === 'rp' && meta.character) {
        embed.fields.push({ name: 'Personnage', value: meta.character, inline: true });
    }
    if (meta.mood) {
        embed.fields.push({ name: 'Ambiance', value: meta.mood, inline: true });
    }
    if (meta.count) {
        embed.fields.push({ name: 'Nb titres', value: meta.count, inline: true });
    }

    embed.fields.push({ name: 'Titres generes', value: titlesList.slice(0, 1024) });

    fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
    }).catch(err => console.error('Webhook error:', err.message));
}

// --- API Proxy ---
app.post('/api/generate', requireAuth, checkBan, checkMaintenance, async (req, res) => {
    const { systemPrompt, userPrompt, meta } = req.body;

    if (!systemPrompt || !userPrompt) {
        return res.status(400).json({ error: 'Parametres manquants' });
    }

    // Refresh roles avant check quota
    const freshRoles = await fetchMemberRoles(req.session.user.id);
    if (freshRoles) req.session.user.roles = freshRoles;

    // Check quota (staff + partenaires = illimite)
    const dailyLimit = getUserDailyLimit(req.session.user);
    if (!hasUnlimitedGenerations(req.session.user)) {
        const used = getUserDailyCredits(req.session.user.id);
        if (used >= dailyLimit) {
            return res.status(429).json({
                error: 'limit',
                message: `Tu as atteint ta limite de ${dailyLimit} titres pour aujourd'hui. Reviens demain !`,
                creditsUsed: used,
                creditsMax: dailyLimit
            });
        }
    }

    // Moderation automatique via ChatGPT (staff exempt)
    const isUserStaff = isStaff(req.session.user);
    if (!isUserStaff) {
        const moderation = await checkContentModeration(userPrompt, meta);
        if (moderation.flagged) {
            const userId = req.session.user.id;
            const result = addAutoWarn(userId, moderation.reason);
            if (result) {
                sendWarnWebhook(req.session.user, moderation.reason, result.total, meta);
                // Auto-ban a 3 warns
                if (result.total >= 3) {
                    const bans = loadBans();
                    bans[userId] = {
                        reason: `Auto-ban : ${result.total} avertissements atteints`,
                        date: new Date().toISOString(),
                        permanent: true
                    };
                    saveBans(bans);
                    sendToUser(userId, 'banned', { reason: `Auto-ban : ${result.total} avertissements atteints`, permanent: true, until: null });
                    console.log(`Auto-ban: ${userId} - ${result.total} warns atteints`);
                    return res.status(403).json({
                        error: 'banned',
                        reason: `Auto-ban : ${result.total} avertissements atteints`,
                        permanent: true
                    });
                }
                sendToUser(userId, 'warned', { reason: moderation.reason, total: result.total });
            }
            return res.status(403).json({
                error: 'warned',
                reason: moderation.reason,
                warn: result?.warn || null,
                totalWarns: result?.total || 0
            });
        }
    }

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.9,
                max_tokens: 1000
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            console.error('OpenAI error:', err);
            return res.status(response.status).json({
                error: err.error?.message || `Erreur OpenAI (${response.status})`
            });
        }

        const data = await response.json();
        const content = data.choices[0].message.content;

        // Envoyer le log webhook
        const titles = content.split('\n').filter(t => t.trim()).map(t => t.replace(/^\d+[\.\)]\s*/, '').replace(/^[-*]\s*/, '').trim()).filter(Boolean);
        sendGenerationLog(req.session.user, meta || {}, titles);

        // Mettre a jour les credits quotidiens
        let creditsUsed = null;
        if (!hasUnlimitedGenerations(req.session.user)) {
            creditsUsed = addUserDailyCredits(req.session.user.id, titles.length);
        }

        stats.totalGenerations++;
        stats.totalTitles = (stats.totalTitles || 0) + titles.length;
        const today = new Date().toISOString().slice(0, 10);
        if (!stats.dailyStats) stats.dailyStats = {};
        if (!stats.dailyStats[today]) stats.dailyStats[today] = { generations: 0, titles: 0 };
        stats.dailyStats[today].generations++;
        stats.dailyStats[today].titles += titles.length;
        if (!stats.activeUsers) stats.activeUsers = {};
        if (!stats.activeUsers[today]) stats.activeUsers[today] = 0;
        const udPath = getUserDataPath(req.session.user.id);
        try {
            const ud = JSON.parse(fs.readFileSync(udPath, 'utf8'));
            if (ud._lastActiveDay !== today) {
                ud._lastActiveDay = today;
                fs.writeFileSync(udPath, JSON.stringify(ud), 'utf8');
                stats.activeUsers[today]++;
            }
        } catch {}
        saveStats(stats);
        sendStatusEmbed(maintenanceMode ? 'maintenance' : 'online');

        const resData = { content };
        if (creditsUsed !== null) {
            resData.creditsUsed = creditsUsed;
            resData.creditsMax = getUserDailyLimit(req.session.user);
        }
        res.json(resData);

    } catch (err) {
        console.error('API proxy error:', err);
        res.status(500).json({ error: 'Erreur interne du serveur' });
    }
});

// --- Admin Logs ---
const LOGS_FILE = path.join(__dirname, 'admin-logs.json');

function loadLogs() {
    try {
        if (fs.existsSync(LOGS_FILE)) {
            return JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
        }
    } catch (err) {
        console.error('Erreur lecture admin-logs.json:', err.message);
    }
    return [];
}

function saveLogs(logs) {
    try {
        fs.writeFileSync(LOGS_FILE, JSON.stringify(logs), 'utf8');
    } catch (err) {
        console.error('Erreur ecriture admin-logs.json:', err.message);
    }
}

function addLog(action, performedBy, targetId, details) {
    const logs = loadLogs();
    logs.unshift({
        action,
        performedBy: performedBy ? { id: performedBy.id, username: performedBy.username } : null,
        targetId: targetId || null,
        details: details || '',
        date: new Date().toISOString()
    });
    if (logs.length > 500) logs.length = 500;
    saveLogs(logs);
}

app.get('/admin/logs', requireAdmin, (req, res) => {
    res.json(loadLogs());
});

// --- Admin Stats ---
app.get('/admin/stats', requireAdmin, (req, res) => {
    const currentStats = loadStats();
    let totalUsers = 0;
    const udDir = path.join(__dirname, 'userdata');
    try {
        if (fs.existsSync(udDir)) {
            totalUsers = fs.readdirSync(udDir).filter(f => f.endsWith('.json')).length;
        }
    } catch {}

    res.json({
        totalGenerations: currentStats.totalGenerations || 0,
        totalTitles: currentStats.totalTitles || 0,
        totalUsers,
        dailyStats: currentStats.dailyStats || {},
        activeUsers: currentStats.activeUsers || {}
    });
});

// --- Shared Titles ---
const SHARED_TITLES_FILE = path.join(__dirname, 'shared-titles.json');

function loadSharedTitles() {
    try {
        if (fs.existsSync(SHARED_TITLES_FILE)) {
            return JSON.parse(fs.readFileSync(SHARED_TITLES_FILE, 'utf8'));
        }
    } catch (err) {
        console.error('Erreur lecture shared-titles.json:', err.message);
    }
    return {};
}

function saveSharedTitles(data) {
    try {
        fs.writeFileSync(SHARED_TITLES_FILE, JSON.stringify(data), 'utf8');
    } catch (err) {
        console.error('Erreur ecriture shared-titles.json:', err.message);
    }
}

app.post('/api/titles/share', requireAuth, checkBan, (req, res) => {
    const { title, game, mode } = req.body;
    if (!title) return res.status(400).json({ error: 'Titre requis' });

    const code = generateShareCode();
    const shared = loadSharedTitles();
    shared[code] = {
        title,
        game: game || '',
        mode: mode || 'normal',
        author: { id: req.session.user.id, username: req.session.user.username },
        date: new Date().toISOString()
    };
    saveSharedTitles(shared);
    res.json({ code });
});

app.get('/api/titles/shared/:code', requireAuth, (req, res) => {
    const shared = loadSharedTitles();
    const entry = shared[req.params.code];
    if (!entry) return res.status(404).json({ error: 'Code introuvable' });
    res.json(entry);
});

// --- Scheduler: auto-publish scheduled patchnotes ---
setInterval(() => {
    const patchnotes = loadPatchnotes();
    const now = new Date();
    let changed = false;
    patchnotes.forEach(p => {
        if (!p.published && p.scheduledAt && new Date(p.scheduledAt) <= now) {
            p.published = true;
            changed = true;
            broadcastWS('patchnote', p);
            console.log(`Patchnote auto-publiee: ${p.title}`);
        }
    });
    if (changed) savePatchnotes(patchnotes);
}, 30000);

// --- Start ---
server.listen(PORT, async () => {
    console.log(`Serveur demarre sur http://localhost:${PORT}`);

    // Diagnostic au demarrage
    console.log(`[CONFIG] REQUIRED_GUILD_ID: ${REQUIRED_GUILD_ID || 'NON DEFINI'}`);
    console.log(`[CONFIG] MEMBER_ROLE_ID: ${MEMBER_ROLE_ID || 'NON DEFINI'}`);
    console.log(`[CONFIG] PARTNER_ROLE_ID: ${PARTNER_ROLE_ID || 'NON DEFINI'}`);
    console.log(`[CONFIG] MODERATOR_ROLE_ID: ${MODERATOR_ROLE_ID || 'NON DEFINI'}`);
    console.log(`[CONFIG] DISCORD_BOT_TOKEN: ${DISCORD_BOT_TOKEN ? 'present (' + DISCORD_BOT_TOKEN.substring(0, 10) + '...)' : 'NON DEFINI'}`);

    // Test fetch membre avec le Bot token
    if (DISCORD_BOT_TOKEN && REQUIRED_GUILD_ID) {
        try {
            const testRes = await fetch(
                `https://discord.com/api/guilds/${REQUIRED_GUILD_ID}/members/${ADMIN_DISCORD_ID}`,
                { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
            );
            if (testRes.ok) {
                const member = await testRes.json();
                console.log(`[TEST] Fetch membre OK ! Roles de l'admin: ${JSON.stringify(member.roles)}`);
            } else {
                const errText = await testRes.text();
                console.error(`[TEST] ECHEC fetch membre ! Status: ${testRes.status} - ${errText}`);
            }
        } catch (err) {
            console.error(`[TEST] ECHEC connexion Discord API:`, err.message);
        }
    } else {
        console.error('[TEST] Impossible de tester: BOT_TOKEN ou GUILD_ID manquant');
    }

    // Connexion du bot Discord
    if (DISCORD_BOT_TOKEN && DISCORD_STATUS_CHANNEL_ID) {
        discordBot.login(DISCORD_BOT_TOKEN).catch(err => {
            console.error('Erreur connexion bot Discord:', err.message);
        });
    }
});
