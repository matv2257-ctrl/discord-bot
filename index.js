const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const fs = require("fs");
const { token } = require("./config.json");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const DB_FILE = "./levels.json";

let data = {};
const voiceIntervals = {}; // { [userId]: intervalId }

// ===== DB Load/Save =====
function load() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, "{}", "utf8");
    data = {};
    return;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    console.error("levels.json 파싱 실패(파일 깨짐 가능):", e);
    data = {};
  }
}
function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf8");
}

// ===== User Init =====
function initUser(userId) {
  if (!data[userId]) {
    data[userId] = {
      chatXp: 0,
      chatTotalXp: 0,
      chatLevel: 1,
      voiceXp: 0,
      voiceTotalXp: 0,
      voiceLevel: 1,
    };
  }
}

// ===== Required XP (지수 증가) =====
// 채팅: 1렙 100, 2렙 200, 3렙 400 ...
function chatRequiredXp(level) {
  return 100 * Math.pow(2, level - 1);
}
// 보이스: 시작값만 다르게(원하면 100으로 맞춰도 됨)
// 1렙 200, 2렙 400, 3렙 800 ...
function voiceRequiredXp(level) {
  return 200 * Math.pow(2, level - 1);
}

load();

client.once("ready", () => {
  console.log(`Ready! Logged in as ${client.user.tag}`);
});

// =======================
// 💬 채팅 + !rank (임베드)
// =======================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const userId = message.author.id;
  initUser(userId);

  // ===== !rank (나 / 멘션 / ID) =====
  if (message.content.startsWith("!rank")) {
    const parts = message.content.trim().split(/\s+/);

    let targetUser = message.author;

    // 멘션 우선
    const mentioned = message.mentions.users.first();
    if (mentioned) {
      targetUser = mentioned;
    } else if (parts.length >= 2) {
      // ID 조회
      const maybeId = parts[1];
      if (/^\d{15,20}$/.test(maybeId)) {
        try {
          targetUser = await client.users.fetch(maybeId);
        } catch {
          return message.reply("그 ID의 유저를 찾지 못했습니다.");
        }
      }
    }

    const targetId = targetUser.id;
    initUser(targetId);
    const u = data[targetId];

    const chatNeed = chatRequiredXp(u.chatLevel);
    const voiceNeed = voiceRequiredXp(u.voiceLevel);

    const chatPct = chatNeed > 0 ? Math.floor((u.chatXp / chatNeed) * 100) : 0;
    const voicePct =
      voiceNeed > 0 ? Math.floor((u.voiceXp / voiceNeed) * 100) : 0;

    const embed = new EmbedBuilder()
      .setTitle("📊 Rank")
      .setDescription(`대상: <@${targetId}>`)
      .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
      .addFields(
        {
          name: "💬 채팅",
          value:
            `레벨: **${u.chatLevel}**\n` +
            `XP: **${u.chatXp} / ${chatNeed}** (${chatPct}%)\n` +
            `총 XP: **${u.chatTotalXp}**`,
          inline: true,
        },
        {
          name: "🎤 보이스",
          value:
            `레벨: **${u.voiceLevel}**\n` +
            `XP: **${u.voiceXp} / ${voiceNeed}** (${voicePct}%)\n` +
            `총 XP: **${u.voiceTotalXp}**`,
          inline: true,
        }
      )
      .setFooter({ text: "Luna Rank Bot" })
      .setTimestamp();

    return message.reply({ embeds: [embed] });
  }

  // ===== 채팅 XP (메시지당 3) =====
  data[userId].chatXp += 3;
  data[userId].chatTotalXp += 3;

  const need = chatRequiredXp(data[userId].chatLevel);
  if (data[userId].chatXp >= need) {
    data[userId].chatXp -= need;
    data[userId].chatLevel += 1;
    message.channel.send(
      `${message.author} 💬 채팅 레벨업! Lv.${data[userId].chatLevel}`
    );
  }

  save();
});

//=======================
// 🎤 보이스 레벨 시스템
// =======================
client.on("voiceStateUpdate", (oldState, newState) => {
  // 봇이면 무시
  if (newState.member && newState.member.user && newState.member.user.bot)
    return;

  const userId = newState.id;
  initUser(userId);

  // 입장(없음 -> 있음)
  if (!oldState.channel && newState.channel) {
    if (voiceIntervals[userId]) return; // 중복 방지

    voiceIntervals[userId] = setInterval(() => {
      const member = newState.guild.members.cache.get(userId);

      // 멤버 없거나 보이스에 없으면 정리
      if (!member || !member.voice || !member.voice.channel) {
        clearInterval(voiceIntervals[userId]);
        delete voiceIntervals[userId];
        return;
      }

      // 1분당 보이스 XP 20 (원하면 10으로 바꿔도 됨)
      data[userId].voiceXp += 20;
      data[userId].voiceTotalXp += 20;

      const need = voiceRequiredXp(data[userId].voiceLevel);
      if (data[userId].voiceXp >= need) {
        data[userId].voiceXp -= need;
        data[userId].voiceLevel += 1;

        const sys = member.guild.systemChannel;
        if (sys) {
          sys.send(
            `<@${userId}> 🎤 보이스 레벨업! Lv.${data[userId].voiceLevel}`
          );
        }
      }

      save();
    }, 60000);
  }

  // 퇴장(있음 -> 없음)
  if (oldState.channel && !newState.channel) {
    if (voiceIntervals[userId]) {
      clearInterval(voiceIntervals[userId]);
      delete voiceIntervals[userId];
    }
  }
});

client.login(token);