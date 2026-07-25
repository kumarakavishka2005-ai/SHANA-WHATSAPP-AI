const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay,
  Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const fs = require('fs');

// ─── Railway Keep-Alive HTTP Server ──────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('SHANA AI Bot is running 24/7!\n');
});
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

// ─── Message Queue (Rate Limiter + Jitter) ───────────────────────────────
const messageQueue = [];
let queueProcessing = false;

function enqueueMessage(sock, jid, content) {
  messageQueue.push({ sock, jid, content, timestamp: Date.now() });
  if (!queueProcessing) processQueue();
}

async function processQueue() {
  queueProcessing = true;
  while (messageQueue.length > 0) {
    const task = messageQueue.shift();
    try {
      await task.sock.sendMessage(task.jid, task.content);
      // Gaussian-like jitter: 3-7 seconds between messages
      const jitter = 3000 + Math.floor(Math.random() * 2000) + Math.floor(Math.random() * 2000);
      await delay(jitter);
    } catch (e) {
      console.log('Queue send error:', e.message);
    }
  }
  queueProcessing = false;
}

// ─── Human-like typing (gracefully handles @lid failures) ────────────────
async function simulateHumanTyping(sock, jid, text) {
  try {
    await sock.presenceSubscribe(jid).catch(() => {});
    await delay(500 + Math.random() * 1500);
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    const typingTime = Math.min(Math.max(text.length * 25, 800), 6000);
    await delay(typingTime);
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
  } catch (e) {
    // Silently continue — presence is non-critical
  }
}

// ─── Cooldown (20 min for non-menu messages) ─────────────────────────────
const userCooldowns = new Map();
const COOLDOWN_TIME = 20 * 60 * 1000;

function checkCooldown(userId) {
  const lastTime = userCooldowns.get(userId);
  const now = Date.now();
  if (lastTime && (now - lastTime < COOLDOWN_TIME)) return false;
  userCooldowns.set(userId, now);
  return true;
}

// ─── Reconnection with backoff ──────────────────────────────────────────
let reconnectAttempts = 0;
function getReconnectDelay() {
  reconnectAttempts++;
  const base = Math.min(5000 * Math.pow(1.5, reconnectAttempts - 1), 60000);
  return Math.floor(base + Math.random() * 3000);
}

// ─── Normalize JID (@lid -> @s.whatsapp.net) ─────────────────────────────
function normalizeJid(jid) {
  if (jid.endsWith('@lid')) {
    // Extract the phone number from lid format
    const number = jid.replace('@lid', '');
    // If it's a full phone number, convert to standard JID
    if (number.length >= 10 && !isNaN(number)) {
      return number + '@s.whatsapp.net';
    }
    return jid; // fallback
  }
  return jid;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,
    emitOwnEvents: true,
    getMessage: async () => { return { conversation: 'hello' } },
    keepAliveIntervalMs: 25000,
    maxRetries: 10,
    defaultQueryTimeoutMs: 30000,
    // FIX: Use syncFullHistory to get contacts list
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  // ── Pairing Code ──────────────────────────────────────────────────────
  if (!sock.authState.creds.registered) {
    const phoneNumber = process.env.PHONE_NUMBER;
    if (!phoneNumber) {
      console.log('\n❌ Error: Set PHONE_NUMBER in Railway Variables (e.g., 9471xxxxxxx)\n');
      process.exit(1);
    }
    console.log('\n⏳ Generating pairing code...');
    await delay(5000);
    try {
      let code = await sock.requestPairingCode(phoneNumber.trim().replace(/[^0-9]/g, ''));
      code = code?.match(/.{1,4}/g)?.join('-') || code;
      console.log(`\n========================================`);
      console.log(`📌 Pairing Code: \x1b[32m${code}\x1b[0m`);
      console.log(`========================================\n`);
    } catch (err) {
      console.log('❌ Pairing code error:', err.message);
    }
  }

  // ── Connection Events ──────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting...', shouldReconnect);
      if (shouldReconnect) {
        const reconnectDelay = getReconnectDelay();
        console.log(`Reconnecting in ${Math.round(reconnectDelay/1000)}s (attempt ${reconnectAttempts})...`);
        setTimeout(() => startBot(), reconnectDelay);
      } else {
        console.log('Permanently logged out. Delete auth_info_baileys folder and re-pair.');
        reconnectAttempts = 0;
      }
    } else if (connection === 'open') {
      console.log('\n✅ SHANA AI Bot successfully connected to WhatsApp!');
      reconnectAttempts = 0;
      // Go online briefly then offline after ~10 min
      await sock.sendPresenceUpdate('available');
      setTimeout(async () => {
        try { await sock.sendPresenceUpdate('unavailable'); } catch(e) {}
      }, 600000 + Math.random() * 300000);
    }
  });

  // ── Message Handler ─────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      const mek = chatUpdate.messages[0];
      if (!mek.message) return;
      if (mek.key.fromMe) return;
      if (mek.key.remoteJid.endsWith('@g.us')) return; 

      // FIX: Normalize @lid to @s.whatsapp.net
      const rawJid = mek.key.remoteJid;
      const sender = normalizeJid(rawJid);

      // Extract message text
      const messageType = Object.keys(mek.message)[0];
      let body = '';
      if (messageType === 'conversation') {
        body = mek.message.conversation;
      } else if (messageType === 'extendedTextMessage') {
        body = mek.message.extendedTextMessage?.text || '';
      } else if (messageType === 'imageMessage') {
        body = mek.message.imageMessage?.caption || '';
      } else if (messageType === 'videoMessage') {
        body = mek.message.videoMessage?.caption || '';
      }

      const text = body.trim();
      if (!text) return;

      console.log(`📩 Message from (${sender}): ${text}`);

      // Logo image check
      let hasLogo = fs.existsSync('./logo.jpg');
      let logoBuffer = hasLogo ? fs.readFileSync('./logo.jpg') : null;

      // ── MENU OPTIONS 1-7 (NO COOLDOWN) ──────────────────────────────
      if (['1', '2', '3', '4', '5', '6', '7'].includes(text)) {

        await delay(1500 + Math.random() * 2000);
        await simulateHumanTyping(sock, sender, 'replying...');

        let replyText = '';

        switch (text) {
          case '1':
            replyText = `💗🇱🇰🙏ආයුබෝවන්🙏🇱🇰💗\n *1X BET සහ WITHDRAWAL ඉතා ඉක්මනින් ලබාගන්න...* \n\n *SHANA SERVICE __💯* \n\n    💵💵 *මුදල් තැන්පත් කිරීම*💵💵\n✅ *Account Deposit*✅ *Account Withdraw*\n\n🔯 BOC \n🔯 94118758\n🔯MINNERIYA\n🔯 K.G LAKSHAN KAVISHKA KUMARA\n\n✳️PEOPLE BANK : 006200150094114\n ✳️K.G.LAKSHAN KAVISHKA KUMARA \n✳️HIGURAKGODA\n\n✳️  ez cash : 0764104588\n✳️LAKSHAN ( open ) \n ( වැඩ්පුර රුපියල් 20-/ දැමිමට කාරුණික වන්න )\n\n✡️ Binanace \n✡️1066282628\n✡️ LAKSHAN \n\n🔯ipay \n🔯0764104588\n🔯Lakshan\n\n✡️Dialog Finance PLC \n✡️0010 2217 5776\n✡️ LAKSHAN KAVISHKA KUMARA\n\n *❏ DEPOSIT - minute 2-5 😍* \n *❏ WITHDRAW - minute 10-30 😍* \n👉👉 *සැ.යු.* : ඔබ විසින් *REMARK* යටතේ ඔබගේ PLAYER ID සඳහන් කල යුතුමය.\nතවද 1X BET, BET යන වචන කිසි සේත්ම භාවිතා නොකල යුතුය...\n\n⚠️️ඉහත ක්‍රම හරහා *DEPOSIT* කර \n SLIP* එක හා ඔබේ *1XBET PLAYER ID* *type එවන්න* \n\n👉සැ.යු. : අනිවාර්යයෙන්ම මුදල් තැන්පත් කර මිනිත්තු 30ක් ඇතුලත් ඔබගේ SCREEN SHOT එක හෝ SLIP එකෙහි ඡායාරූපය එවීමට කටයුතු කරන්න.\n\nඑසේ නොහැකි නම් පණිවිඩයක් එවීමට කාරුණිකවන්න .\n\n✺ තෙවනපාර්ශවීය සල්ලි දැමිම් බාරගනු නොලැබේ ❌`;
            break;
          case '2':
            replyText = `*❏ SHANA WITHDRAW ADDRESS ✺*\n\n _MINI Withdraw Rs 250-/_ \nපියවර 1 \n* මුලින්ම 1Xbet app එක open කරන්න ඉට පසු menu යන්න. \n* *ඉට පසු උඩම ඇති setting අයිකන් එකක් එක ක්ලික් කරන්න*\n\n *✺ ඉට පසුව withdraw කියලා අයිකන් එකක් ඇති එක ඔබන්න ඉට පස්සෙ 1XBET CASH කියන් මේතඩ් එක තොරන්න පොඩ්ඩක් පහලට වේන්න තියෙන්නේ*\n\n➢ ඉට පසු ඔබට ගන්න ඔනි ගාන ගහන්න.\n\n❏ city: minneriya පුරවන්න\n❏ street : Lakshan service (24/7) \n\nපුරවගන්න ඉන් පසු ඔබට ඔබගේ gamil එකක් හො phone නම්බ එකක් ඇඩ් කරලා තියේනවානම් කොඩ් එකක් එයි එක දිලා කන්පොම් කරන්න.\n\n *➢ ඉන් පසුව ඇප් එකේන් බැක් වී ආපාසු ඇප් එකට ලොග් වී විත්‍රොල් තැනට යන්න.* \n\n➢ ඉට පඩු විත්‍රොල් රේපුස්ට කියලා බටන් එකක් ඇති එක ඔබන්න.\n\n➢ ඉන් පසුව ඉංග්‍රිසි වචන සහිතව නිල්පාටින් වචන වගයක් ඇවිත් ඇති එහි ඇති ගෙට් කොඩ් කියලා එකක් අන්න එක ඔබන්න.\n\n➢ එක ඔබවුවට පසුව එනවා කොඩ් එකක් අන්න එකි ස්ක්‍රින් ශොට් එකක් ගහලා ok කරලා මට එවන්න .\n\nඑච්චරයි ✅`;
            break;
          case '3':
            replyText = `VIP 1XBET PROMO CODE ඔයාල්ත් දැන්ම රෙජිස්ට වේන්න!...;\n\nLashan1x\n👆👆👆👆\nLOST නොවී ගෙමක් ගහන්න කැමති අය දැන්ම ගිහින් 1XBET ACCOUNT එකක් හාදාගන්න\n200% DEPOSIT BONUS ✅`;
            break;
          case '4':
            replyText = `0758862130/0742381405 Call එකකින් විස්තර දැනගන්න....\n🤝🤝🤝🤝🤝🤝🤝🤝`;
            break;
          case '5':
            replyText = `0758862130/0742381405/0703557568\nCall , Mg 24/7 Ok ✅`;
            break;
          case '6':
            replyText = `0758862130/0742381405 Call එකකින් විස්තර දැනගන්න....\n🤝🤝🤝🤝🤝🤝🤝🤝`;
            break;
          case '7':
            replyText = `ඔබට අඩුම මුදලට 24/7 AUTO reply Bot කෙනෙක් ඔබගේ නමින් හාදාගැනිමට අවශ්ශයයිනම් පහල දුරකතන අංයට අමතන්න 0758862130 ✅`;
            break;
        }

        if (logoBuffer) {
          enqueueMessage(sock, sender, { image: logoBuffer, caption: `SHANA LOGO 🕹\n\n` + replyText });
        } else {
          enqueueMessage(sock, sender, { text: `SHANA 🕹\n\n` + replyText });
        }

      } else {
        // ── NON-MENU MESSAGES (cooldown applies) ──────────────────────
        if (!checkCooldown(sender)) {
          console.log(`Cooldown active for ${sender}, skipping`);
          return;
        }

        await delay(2000 + Math.random() * 3000);
        await simulateHumanTyping(sock, sender, 'welcome message...');

        const welcomeMsg = `SHANA AI BOT SYSTEM 🕹\n-----------------------------\nHI සුබ දවසක් සර්,මිස් 😚\n\nඔබට අවශ්ශය උපකාරය පවසන්න ! මම ඔබට සහය වීම සදහා බැදීසිටින්නේමී...!\n\n📜 SHANA All SERVICE \n\n1. SHANA 1XBET DEPOSIT තොරතුරු ✅\n2. SHANA 1XBET WITHDRAW තොරතුරු ✅\n3. SHANA 1XBET VIP PROMO CODE තොරතුරු ✅\n4. WEB SITE & SOFTWARE සාදාගැනිමට ✅\n5. SOCAL MRDIA BOOST ( All plate Fom ) \n5. SHANA CONTACTS කරගැනිමට ✅\n6. AVIATOR HIGH ODD අනලයිසින් ඉගෙන ගැනිමටනම් ✅\n7.Whatsapp Ai Auto Replay Bot සාදාගැනිමටනම් ✅\n\nකරුණාකරලා ඔබට අවශ්ශය සෙවාව උඩ Menu එකේ ඇත්නම් එම අංකය ලාබාදෙන්න!.....\n\nඔබට වෙනත් කරුණක් දැන්විමට අවශ්ශයනම් පහලින් සදහන් කරන්න මම එය ඉතාමත් ඉක්මනට SHANA වේත දැන්වීමට සලස්වන්නම් \n--------------------------------\nSOFTWARE DEVELOPR SHANA 🐛`;

        if (logoBuffer) {
          enqueueMessage(sock, sender, { image: logoBuffer, caption: `SHANA 🕹\n\n` + welcomeMsg });
        } else {
          enqueueMessage(sock, sender, { text: `SHANA 🕹\n\n` + welcomeMsg });
        }

        // Fallback message after 10-15 second delay (only if cooldown passed)
        await delay(10000 + Math.random() * 5000);
        await simulateHumanTyping(sock, sender, 'fallback...');

        const fallbackMsg = ` -\nමතක් රැදීසීටින් හැකි ඉක්මනින් SHANA Online ගෙන්වා ගැනිමට උත්සහ කරන්නෙමී....! \nඔහුට තිබෙන වැඩත් එක්ක ඔහු කාර්රය බහුල වී ඇතී අතර ඉමනින් පැමිනේවී...`;

        enqueueMessage(sock, sender, { text: fallbackMsg });
      }

    } catch (error) {
      // FIXED: No raw Sinhala text — proper error logging
      console.log('Error handling message:', error.message);
      console.log('Stack:', error.stack);
    }
  });
}

startBot();
