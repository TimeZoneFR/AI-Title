require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

// --- Config ---
const {
    OPENAI_API_KEY,
    DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET,
    DISCORD_REDIRECT_URI,
    REQUIRED_GUILD_ID,
    REQUIRED_ROLE_ID,
    SESSION_SECRET,
    DISCORD_WEBHOOK_URL
} = process.env;

const ADMIN_DISCORD_ID = '1148249755458228286';

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
                        content: `Tu es un moderateur de contenu. Analyse le texte fourni et determine s'il contient du contenu inapproprie.

Contenu INTERDIT :
- Noms de dictateurs, criminels de guerre, figures haineuses (Hitler, Staline, Mussolini, Pol Pot, etc.)
- Insultes, vulgarites, gros mots (fdp, ntm, nique, merde, putain, connard, salope, pd, etc.)
- Contenu raciste, sexiste, homophobe, discriminatoire
- References au nazisme, fascisme, terrorisme, ideologies extremistes
- Contenu sexuel ou pornographique
- Incitation a la violence ou a la haine
- Harcelement, menaces
- Tout contenu inapproprie pour un service tout public

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

    const embed = {
        title: '⚠️ Avertissement automatique',
        color: 0xff0000,
        fields: [
            { name: 'Utilisateur', value: `${user.username} (\`${user.id}\`)`, inline: true },
            { name: 'Warns', value: `${totalWarns}/3`, inline: true },
            { name: 'Raison', value: reason },
            { name: 'Mode', value: meta?.mode === 'rp' ? 'RP' : 'Normal', inline: true },
            { name: meta?.mode === 'rp' ? 'Serveur' : 'Jeu', value: meta?.game || 'Non specifie', inline: true }
        ],
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

// --- SSE (Server-Sent Events) ---
const sseClients = [];
const SERVER_VERSION = Date.now().toString();

function broadcastSSE(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(res => res.write(message));
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
    // Admin can always access
    if (req.session && req.session.user && req.session.user.id === ADMIN_DISCORD_ID) {
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
        scope: 'identify guilds.members.read'
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

        // Check guild membership and role
        const memberRes = await fetch(
            `https://discord.com/api/users/@me/guilds/${REQUIRED_GUILD_ID}/member`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (!memberRes.ok) {
            const memberErr = await memberRes.text();
            console.error(`Guild member fetch failed (${memberRes.status}):`, memberErr);
            if (memberRes.status === 404 || memberRes.status === 403) {
                return res.redirect('/?error=not_in_guild');
            }
            return res.redirect('/?error=guild_fetch_failed');
        }

        const member = await memberRes.json();

        // Check for required role
        if (REQUIRED_ROLE_ID && !member.roles.includes(REQUIRED_ROLE_ID)) {
            console.error(`User ${user.username} missing role. Has: [${member.roles.join(', ')}], needs: ${REQUIRED_ROLE_ID}`);
            return res.redirect('/?error=missing_role');
        }

        // All checks passed - create session
        req.session.user = {
            id: user.id,
            username: user.username,
            discriminator: user.discriminator || '0',
            avatar: user.avatar
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
                lastLogin: new Date().toISOString()
            };
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
app.get('/auth/me', (req, res) => {
    if (req.session && req.session.user) {
        const banned = isUserBanned(req.session.user.id);
        const banInfo = banned ? loadBans()[req.session.user.id] : null;
        const userWarns = getUserWarns(req.session.user.id);
        return res.json({
            ...req.session.user,
            isAdmin: req.session.user.id === ADMIN_DISCORD_ID,
            maintenance: maintenanceMode,
            banned,
            banInfo,
            warns: userWarns
        });
    }
    res.status(401).json({ error: 'Non authentifie' });
});

// Logout
app.get('/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ ok: true });
    });
});

// --- SSE Endpoint ---
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Envoyer la version du serveur a la connexion
    res.write(`event: version\ndata: ${JSON.stringify({ version: SERVER_VERSION })}\n\n`);

    sseClients.push(res);
    req.on('close', () => {
        const index = sseClients.indexOf(res);
        if (index !== -1) sseClients.splice(index, 1);
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
    broadcastSSE('maintenance', { enabled: maintenanceMode });
    console.log(`Maintenance mode: ${maintenanceMode ? 'ON' : 'OFF'}`);
    res.json({ maintenance: maintenanceMode });
});

// --- Admin User Lookup ---
app.get('/admin/user/:id', requireAdmin, (req, res) => {
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

    res.json({
        userId,
        exists: !!userData,
        profile: userData?.profile || null,
        firstSeen: userData?.firstSeen || null,
        presetsCount: (userData?.presets || []).length,
        titleHistory: userData?.titleHistory || [],
        banned: isBanned,
        banInfo: isBanned ? ban : null,
        warns: userWarns
    });
});

// --- Admin Ban Routes ---
app.get('/admin/bans', requireAdmin, (req, res) => {
    const bans = loadBans();
    res.json(bans);
});

app.post('/admin/ban', requireAdmin, (req, res) => {
    const { userId, reason, duration, permanent } = req.body;
    if (!userId || !userId.trim()) {
        return res.status(400).json({ error: 'ID utilisateur requis' });
    }

    const cleanId = userId.trim();
    if (cleanId === ADMIN_DISCORD_ID) {
        return res.status(400).json({ error: 'Impossible de bannir un administrateur' });
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
    console.log(`Ban: ${cleanId} - ${ban.permanent ? 'Permanent' : 'Jusqu\'a ' + ban.until} - Raison: ${ban.reason}`);
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
            return res.json({ ok: true });
        }
        return res.status(404).json({ error: 'Aucune donnee trouvee pour cet utilisateur' });
    } catch (err) {
        console.error('Erreur clear history:', err.message);
        return res.status(500).json({ error: 'Erreur serveur' });
    }
});

// --- Admin Warn Routes ---
app.get('/admin/warns', requireAdmin, (req, res) => {
    const warns = loadWarns();
    res.json(warns);
});

app.post('/admin/warn', requireAdmin, (req, res) => {
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
        date: new Date().toISOString()
    };

    warns[cleanId].push(warn);
    saveWarns(warns);
    console.log(`Warn: ${cleanId} - Raison: ${warn.reason} (Total: ${warns[cleanId].length})`);
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
    res.json({ ok: true });
});

app.post('/admin/clear-warns', requireAdmin, (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'ID utilisateur requis' });

    const warns = loadWarns();
    delete warns[userId];
    saveWarns(warns);
    console.log(`Clear warns: ${userId}`);
    res.json({ ok: true });
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
        broadcastSSE('patchnote', newNote);
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

    // Moderation automatique via ChatGPT
    const moderation = await checkContentModeration(userPrompt, meta);
    if (moderation.flagged) {
        const userId = req.session.user.id;
        const result = addAutoWarn(userId, moderation.reason);
        if (result) {
            sendWarnWebhook(req.session.user, moderation.reason, result.total, meta);
        }
        return res.status(403).json({
            error: 'warned',
            reason: moderation.reason,
            warn: result?.warn || null,
            totalWarns: result?.total || 0
        });
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

        res.json({ content });

    } catch (err) {
        console.error('API proxy error:', err);
        res.status(500).json({ error: 'Erreur interne du serveur' });
    }
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
            broadcastSSE('patchnote', p);
            console.log(`Patchnote auto-publiee: ${p.title}`);
        }
    });
    if (changed) savePatchnotes(patchnotes);
}, 30000);

// --- Start ---
app.listen(PORT, () => {
    console.log(`Serveur demarre sur http://localhost:${PORT}`);
});
