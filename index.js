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

// ─── ANTI-BAN: Message Queue with Rate Limiter ─────────────────────────────
const messageQueue = [];
let queueProcessing = false;

function enqueueMessage(sock, jid, content, priority = 0) {
  messageQueue.push({ sock, jid, content, priority, timestamp: Date.now() });
  if (!queueProcessing) processQueue();
}

async function processQueue() {
  queueProcessing = true;
  while (messageQueue.length > 0) {
    // Sort: higher priority first, then FIFO
    messageQueue.sort((a, b) => b.priority - a.priority || a.timestamp - b.timestamp);
    const task = messageQueue.shift();
    try {
      await task.sock.sendMessage(task.jid, task.content);
      // ANTI-BAN: Gaussian jitter between messages (2-6 seconds)
      const baseDelay = 4000;
      const jitter = (Math.random() + Math.random()) * 2000 - 1000; // Box-Muller approximation
      await delay(Math.max(1500, baseDelay + jitter));
    } catch (e) {
      console.log('Queue send error:', e.message);
    }
  }
  queueProcessing = false;
}

// ─── ANTI-BAN: Exponential Backoff Reconnect ───────────────────────────────
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60000; // max 1 min

function getReconnectDelay() {
  reconnectAttempts++;
  const base = Math.min(5000 * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
  const jitter = Math.random() * 2000;
  return Math.floor(base + jitter);
}

// ─── ANTI-BAN: Human Typing Simulator (30ms per character) ─────────────────
async function simulateHumanTyping(sock, jid, text) {
  try {
    // Random presence delay
    await delay(1000 + Math.random() * 2000);
    await sock.presenceSubscribe(jid);
    await delay(500 + Math.random() * 1000);
    
    await sock.sendPresenceUpdate('composing', jid);
    
    // ~30ms per character = natural typing speed
    const typingTime = Math.min(Math.max(text.length * 30, 1000), 8000);
    await delay(typingTime + Math.random() * 1000);
    
    await sock.sendPresenceUpdate('paused', jid);
  } catch (e) {
    // Silently fail on presence errors
  }
}

// ─── ANTI-BAN: Cooldown & Rate Limit Tracking ──────────────────────────────
const userCooldowns = new Map();
const COOLDOWN_TIME = 20 * 60 * 1000; // 20 min
const userMessageCount = new Map();
const HOURLY_LIMIT = 25; // Max 25 messages per user per hour

function checkCooldown(userId) {
  const lastTime = userCooldowns.get(userId);
  const now = Date.now();
  if (lastTime && (now - lastTime < COOLDOWN_TIME)) {
    return false;
  }
  userCooldowns.set(userId, now);
  return true;
}

function checkHourlyLimit(userId) {
  const now = Date.now();
  const hour = Math.floor(now / 3600000);
  const key = `${userId}:${hour}`;
  const count = userMessageCount.get(key) || 0;
  if (count >= HOURLY_LIMIT) return false;
  userMessageCount.set(key, count + 1);
  // Clean old entries periodically
  if (userMessageCount.size > 1000) {
    const cutoff = now - 7200000;
    for (const [k, v] of userMessageCount) {
      const ts = parseInt(k.split(':')[1]) * 3600000;
      if (ts < cutoff) userMessageCount.delete(k);
    }
  }
  return true;
}

// Railway keep-alive HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('SHANA AI Bot is running 24/7!\n');
});
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

// ─── ANTI-BAN: Human-like presence scheduler ───────────────────────────────
let reconnectTimer = null;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),
    // ANTI-BAN: Don't always mark online
    markOnlineOnConnect: false,
    emitOwnEvents: true,
    // ANTI-BAN: Proper syntheticMessage
    getMessage: async () => { return { conversation: 'hello' } },
    // ANTI-BAN: Connection keep-alive
    keepAliveIntervalMs: 25000,
    // ANTI-BAN: Maximum reconnection attempts
    maxRetries: 10,
    // ANTI-BAN: Default query timeout
    defaultQueryTimeoutMs: 30000
  });

  sock.ev.on('creds.update', saveCreds);

  // Pairing Code
  if (!sock.authState.creds.registered) {
    const phoneNumber = process.env.PHONE_NUMBER;
    
    if (!phoneNumber) {
      console.log('\n❌ දෝෂයකි: කරුණාකර Railway Variables වල "PHONE_NUMBER" නමින් ඔබගේ WhatsApp අංකය (උදා: 9471xxxxxxx) ඇතුළත් කරන්න!\n');
      return;
    }

    console.log(`\n⏳ Pairing code එක ජනෙරේට් වෙමින් පවතී. කරුණාකර රැඳී සිටින්න...`);
    await delay(5000);
    
    try {
      let code = await sock.requestPairingCode(phoneNumber.trim().replace(/[^0-9]/g, ''));
      code = code?.match(/.{1,4}/g)?.join('-') || code;
      console.log(`\n========================================`);
      console.log(`📌 ඔබගේ WhatsApp Pairing Code එක මෙයයි: \x1b[32m${code}\x1b[0m`);
      console.log(`========================================\n`);
    } catch (err) {
      console.log('❌ Pairing Code ලබාගැනීමේදී දෝෂයක් ඇති විය:', err);
    }
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting...', shouldReconnect);
      
      if (shouldReconnect) {
        const reconnectDelay = getReconnectDelay();
        console.log(`Reconnecting in ${Math.round(reconnectDelay/1000)}s (attempt ${reconnectAttempts})...`);
        
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => startBot(), reconnectDelay);
      } else {
        console.log('Logged out permanently. Delete auth_info_baileys folder and re-pair.');
        reconnectAttempts = 0;
      }
    } else if (connection === 'open') {
      console.log('\n✅ SHANA AI Bot සාර්ථකව WhatsApp වෙත සම්බන්ධ විය!');
      reconnectAttempts = 0;
      
      // ANTI-BAN: Go online briefly then go offline after 5 min
      await sock.sendPresenceUpdate('available');
      setTimeout(async () => {
        try {
          await sock.sendPresenceUpdate('unavailable');
        } catch(e) {}
      }, 5 * 60 * 1000 + Math.random() * 120000);
    }
  });

  // Message handler
  sock.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      const mek = chatUpdate.messages[0];
      if (!mek.message) return;
      
      if (mek.key.fromMe) return;
      if (mek.key.remoteJid.endsWith('@g.us')) return; 

      const sender = mek.key.remoteJid;
      
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

      // Logo image
      let logoMessageOptions = {};
      if (fs.existsSync('./logo.jpg')) {
        logoMessageOptions = { image: fs.readFileSync('./logo.jpg') };
      }

      // Menu (1-7) — No cooldown for menu items
      if (['1', '2', '3', '4', '5', '6', '7'].includes(text)) {
        
        if (text === '1') {
          const replyText = `💗🇱🇰🙏ආයුබෝවන්🙏🇱🇰💗\n *1X BET සහ WITHDRAWAL ඉතා ඉක්මනින් ලබාගන්න...* \n\n *SHANA SERVICE __💯* \n\n    💵💵 *මුදල් තැන්පත් කිරීම*💵💵\n✅ *Account Deposit*✅ *Account Withdraw*\n\n🔯 BOC \n🔯 94118758\n🔯MINNERIYA\n🔯 K.G LAKSHAN KAVISHKA KUMARA\n\n✳️PEOPLE BANK : 006200150094114\n ✳️K.G.LAKSHAN KAVISHKA KUMARA \n✳️HIGURAKGODA\n\n✳️  ez cash : 0764104588\n✳️LAKSHAN ( open ) \n ( වැඩ්පුර රුපියල් 20-/ දැමිමට කාරුණික වන්න )\n\n✡️ Binanace \n✡️1066282628\n✡️ LAKSHAN \n\n🔯ipay \n🔯0764104588\n🔯Lakshan\n\n✡️Dialog Finance PLC \n✡️0010 2217 5776\n✡️ LAKSHAN KAVISHKA KUMARA\n\n *❏ DEPOSIT - minute 2-5 😍* \n *❏ WITHDRAW - minute 10-30 😍* \n👉👉 *සැ.යු.* : ඔබ විසින් *REMARK* යටතේ ඔබගේ PLAYER ID සඳහන් කල යුතුමය.\nතවද 1X BET    , BET යන වචන කිසි සේත්ම භාවිතා නොකල යුතුය...\n\n⚠️️ඉහත ක්‍රම හරහා *DEPOSIT* කර \n SLIP* එක හා ඔබේ *1XBET PLAYER ID* *type එවන්න* \n\n👉සැ.යු. : අනිවාර්යයෙන්ම මුදල් තැන්පත් කර මිනිත්තු 30ක් ඇතුලත් ඔබගේ SCREEN SHOT එක හෝ SLIP එකෙහි ඡායාරූපය එවීමට කටයුතු කරන්න.\n\nඑසේ නොහැකි නම් පණිවිඩයක් එවීමට කාරුණිකවන්න .\n\n✺ තෙවනපාර්ශවීය සල්ලි දැමිම් බාරගනු නොලැබේ ❌`;
          
          // ANTI-BAN: Simulate reading the message first
          await delay(1000 + Math.random() * 2000);
          await simulateHumanTyping(sock, sender, replyText);
          
          if (logoMessageOptions.image) {
            // Use queue for rate-limited sending
            enqueueMessage(sock, sender, { image: logoMessageOptions.image, caption: `SHANA LOGO 🕹\n\n` + replyText }, 1);
          } else {
            enqueueMessage(sock, sender, { text: `SHANA  🕹\n\n` + replyText }, 1);
          }
        } 
        else if (text === '2') {
          const replyText = `*❏ SHANA WITHDRAW  ADDRESS ✺*\n\n _MINI Withdraw  Rs 250-/_ \nපියවර 1 \n* මුලින්ම 1Xbet app එක open කරන්න ඉට පසු menu යන්න. \n * *ඉට පසු උඩම ඇති setting  අයිකන් එකක් එක ක්ලික් කරන්න*\n\n *✺ ඉට පසුව withdraw  කියලා අයිකන් එකක් ඇති එක ඔබන්න ඉට පස්සෙ 1XBET CASH කියන් මේතඩ් එක තොරන්න පොඩ්ඩක් පහලට වේන්න තියෙන්නේ*\n\n➢ ඉට පසු ඔබට ගන්න ඔනි ගාන ගහන්න.\n\n❏ city: minneriya පුරවන්න\n❏ street : Lakshan service (24/7) \n\nපුරවගන්න ඉන් පසු ඔබට ඔබගේ gamil එකක් හො phone නම්බ එකක් ඇඩ් කරලා තියේනවානම් කොඩ් එකක් එයි එක දිලා කන්පොම් කරන්න.\n\n *➢ ඉන් පසුව ඇප් එකේන් බැක් වී ආපාසු ඇප් එකට ලොග් වී විත්‍රොල් තැනට යන්න.* \n\n➢ ඉට පඩු විත්‍රොල් රේපුස්ට කියලා බටන් එකක් ඇති එක ඔබන්න.\n\n➢ ඉන් පසුව ඉංග්‍රිසි වචන සහිතව නිල්පාටින් වචන වගයක් ඇවිත් ඇති එහි ඇති ගෙට් කොඩ් කියලා එකක් අන්න එක ඔබන්න.\n\n➢ එක ඔබවුවට පසුව එනවා කොඩ් එකක් අන්න එකි ස්ක්‍රින් ශොට් එකක් ගහලා ok කරලා මට එවන්න .\n\nඑච්චරයි ✅`;

          await delay(1000 + Math.random() * 2000);
          await simulateHumanTyping(sock, sender, replyText);
          
          if (logoMessageOptions.image) {
            enqueueMessage(sock, sender, { image: logoMessageOptions.image, caption: `SHANA LOGO 🕹\n\n` + replyText }, 1);
          } else {
            enqueueMessage(sock, sender, { text: `SHANA  🕹\n\n` + replyText }, 1);
          }
        }
        else if (text === '3') {
          const replyText = `VIP 1XBET PROMO CODE ඔයාල්ත් දැන්ම රෙජිස්ට වේන්න!...;\n\nLashan1x\n👆👆👆👆\nLOST නොවී ගෙමක් ගහන්න කැමති අය දැන්ම ගිහින් 1XBET ACCOUNT එකක් හාදාගන්න\n200% DEPOSIT BONUS ✅`;

          await delay(1000 + Math.random() * 2000);
          await simulateHumanTyping(sock, sender, replyText);
          
          if (logoMessageOptions.image) {
            enqueueMessage(sock, sender, { image: logoMessageOptions.image, caption: `SHANA LOGO 🕹\n\n` + replyText }, 1);
          } else {
            enqueueMessage(sock, sender, { text: `SHANA  🕹\n\n` + replyText }, 1);
          }
        }
        else if (text === '4') {
          const replyText = `0758862130/0742381405 Call එකකින් විස්තර දැනගන්න....\n🤝🤝🤝🤝🤝🤝🤝🤝`;

          await delay(1000 + Math.random() * 2000);
          await simulateHumanTyping(sock, sender, replyText);
          
          if (logoMessageOptions.image) {
            enqueueMessage(sock, sender, { image: logoMessageOptions.image, caption: `SHANA LOGO 🕹\n\n` + replyText }, 1);
          } else {
            enqueueMessage(sock, sender, { text: `SHANA  🕹\n\n` + replyText }, 1);
          }
        }
        else if (text === '5') {
          const replyText = `0758862130/0742381405/0703557568\nCall , Mg 24/7 Ok ✅`;

          await delay(1000 + Math.random() * 2000);
          await simulateHumanTyping(sock, sender, replyText);
          
          if (logoMessageOptions.image) {
            enqueueMessage(sock, sender, { image: logoMessageOptions.image, caption: `SHANA LOGO 🕹\n\n` + replyText }, 1);
          } else {
            enqueueMessage(sock, sender, { text: `SHANA  🕹\n\n` + replyText }, 1);
          }
        }
        else if (text === '6') {
          const replyText = `0758862130/0742381405 Call එකකින් විස්තර දැනගන්න....\n🤝🤝🤝🤝🤝🤝🤝🤝`;

          await delay(1000 + Math.random() * 2000);
          await simulateHumanTyping(sock, sender, replyText);
          
          if (logoMessageOptions.image) {
            enqueueMessage(sock, sender, { image: logoMessageOptions.image, caption: `SHANA LOGO 🕹\n\n` + replyText }, 1);
          } else {
            enqueueMessage(sock, sender, { text: `SHANA 🕹\n\n` + replyText }, 1);
          }
        }
        else if (text === '7') {
          const replyText = `ඔබට අඩුම මුදලට 24/7 AUTO reply Bot කෙනෙක් ඔබගේ නමින් හාදාගැනිමට අවශ්ශයයිනම් පහල දුරකතන අංයට අමතන්න 0758862130 ✅`;

          await delay(1000 + Math.random() * 2000);
          await simulateHumanTyping(sock, sender, replyText);
          
          if (logoMessageOptions.image) {
            enqueueMessage(sock, sender, { image: logoMessageOptions.image, caption: `SHANA LOGO 🕹\n\n` + replyText }, 1);
          } else {
            enqueueMessage(sock, sender, { text: `SHANA  🕹\n\n` + replyText }, 1);
          }
        }
      } 
      else {
        // Non-menu messages — cooldown + hourly limit
        if (!checkCooldown(sender)) return;
        if (!checkHourlyLimit(sender)) return;

        // Welcome message
        const welcomeMsg = `SHANA AI BOT SYSTEM 🕹\n-----------------------------\nHI සුබ දවසක් සර්,මිස් 😚\n\nඔබට අවශ්ශය උපකාරය පවසන්න ! මම ඔබට සහය වීම සදහා බැදීසිටින්නේමී...!\n\n📜 SHANA All SERVICE \n\n1. SHANA 1XBET DEPOSIT තොරතුරු ✅\n2. SHANA 1XBET WITHDRAW තොරතුරු ✅\n3. SHANA 1XBET VIP PROMO CODE තොරතුරු ✅\n4. WEB SITE & SOFTWARE සාදාගැනිමට ✅\n5. SOCAL MRDIA BOOST ( All plate Fom ) \n5. SHANA CONTACTS කරගැනිමට ✅\n6. AVIATOR HIGH ODD අනලයිසින් ඉගෙන ගැනිමටනම් ✅\n7.Whatsapp Ai Auto Replay Bot සාදාගැනිමටනම් ✅\n\nකරුණාකරලා ඔබට අවශ්ශය සෙවාව උඩ Menu එකේ ඇත්නම් එම අංකය ලාබාදෙන්න!..... \n\nඔබට වෙනත් කරුණක් දැන්විමට අවශ්ශයනම් පහලින් සදහන් කරන්න මම එය ඉතාමත් ඉක්මනට SHANA වේත දැන්වීමට සලස්වන්නම් \n--------------------------------\nSOFTWARE DEVELOPR SHANA 🐛`;

        // ANTI-BAN: Simulate reading + typing for first message
        await delay(2000 + Math.random() * 3000);
        await simulateHumanTyping(sock, sender, welcomeMsg);
        
        if (logoMessageOptions.image) {
          enqueueMessage(sock, sender, { image: logoMessageOptions.image, caption: `SHANA  🕹\n\n` + welcomeMsg }, 2);
        } else {
          enqueueMessage(sock, sender, { text: `SHANA  🕹\n\n` + welcomeMsg }, 2);
        }

        // ANTI-BAN: Fallback message — longer delay (8-15s) before second message
        const fallbackDelay = 8000 + Math.random() * 7000;
        await delay(fallbackDelay);
        await simulateHumanTyping(sock, sender, ` -\nමතක් රැදීසීටින් හැකි ඉක්මනින් SHANA Online ගෙන්වා ගැනිමට උත්සහ කරන්නෙමී....  ! \nඔහුට තිබෙන වැඩත් එක්ක ඔහු කාර්රය බහුල වී ඇතී අතර ඉමනින් පැමිනේවී... `);
        
        enqueueMessage(sock, sender, { text: ` -\nමතක් රැදීසීටින් හැකි ඉක්මනින් SHANA Online ගෙන්වා ගැනිමට උත්සහ කරන්නෙමී....  ! \nඔහුට තිබෙන වැඩත් එක්ක ඔහු කාර්රය බහුල වී ඇතී අතර ඉමනින් පැමිනේවී... ` }, 1);
      }

    } catch (error) {
      console.log('Error handling message: ', error);
    }
  });
}

startBot();
