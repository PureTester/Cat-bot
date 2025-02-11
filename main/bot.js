import { Telegraf } from "telegraf";
import { scheduleJob } from "node-schedule";
import pg from "pg";
const { Client } = pg;
import dotenv from "dotenv";
dotenv.config();

// Конфигурация бота и базы данных
const BOT_TOKEN =
  process.env.BOT_TOKEN || "7992161931:AAHkzPMR5VsPOgFIxjbBNy2w1jpuydurrpA";
const dbConfig = {
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "postgres",
  password: process.env.DB_PASSWORD || "Putin",
  port: parseInt(process.env.DB_PORT || "5432"),
};

const dbClient = new Client(dbConfig);
const bot = new Telegraf(BOT_TOKEN);

// Состояние пользователей
const userState = {};

// Подключение к базе данных
dbClient
  .connect()
  .then(() => console.log("Подключение к базе данных успешно."))
  .catch((err) => console.error("Ошибка подключения к базе данных:", err));

// Добавление нового пользователя
async function addUser(userId, username) {
  try {
    const query = "INSERT INTO users (id, username) VALUES ($1, $2)";
    await dbClient.query(query, [userId, username]);
  } catch (error) {
    console.error("Ошибка при добавлении пользователя:", error);
    throw error;
  }
}

const menuKeyboard = {
  reply_markup: JSON.stringify({
    keyboard: [
      [{ text: "Дать таблетку 🐾 " }],
      [{ text: "Показать статистику 📊" }],
    ],
    resize_keyboard: true, // Сделать клавиатуру компактнее
  }),
};

// Глобальная обработка всех сообщений
// bot.use(async (ctx) => {
//   if (ctx.message && ctx.message.text) {
//     const message = ctx.message.text.trim().toLowerCase();

//     if (message === "да") {
//       await handleDoseConfirmation(ctx);
//     } else if (message !== "/start" || "/stats") {
//       ctx.reply("Неизвестная команда. Используйте /start для начала работы.");
//     } else {
//       ctx.reply(
//         'Я не понимаю вас. Чтобы отметить, что таблетка была дана, ответьте "да".'
//       );
//     }
//   }
// });

// Команда /start
bot.command("start", async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || "unknown";

  try {
    const userExists = await checkUserExists(userId);
    if (!userExists) {
      await addUser(userId, username);
    }

    userState[userId] = {
      lastTaken: { morning: false, afternoon: false, evening: false },
    };

    ctx.reply(
      "Привет! Я помогу тебе не забыть дать таблетку коту.",
      menuKeyboard
    );
  } catch (error) {
    console.error("Ошибка при обработке команды /start:", error);
    ctx.reply("Произошла ошибка. Пожалуйста, попробуйте снова.");
  }
});

// Загрузка состояния пользователей из базы данных
async function loadUserStateFromDB() {
  try {
    const usersQuery = "SELECT id FROM users";
    const usersResult = await dbClient.query(usersQuery);

    for (const userRow of usersResult.rows) {
      const userId = userRow.id;

      const statsQuery = `
        SELECT morning, afternoon, evening
        FROM statistics
        WHERE user_id = $1
        ORDER BY data DESC
        LIMIT 1
      `;
      const statsResult = await dbClient.query(statsQuery, [userId]);

      if (statsResult.rowCount > 0) {
        const lastRecord = statsResult.rows[0];
        userState[userId] = {
          lastTaken: {
            morning: lastRecord.morning,
            afternoon: lastRecord.afternoon,
            evening: lastRecord.evening,
          },
        };
      } else {
        userState[userId] = {
          lastTaken: { morning: false, afternoon: false, evening: false },
        };
      }
    }

    console.log("Состояние пользователей успешно загружено из базы данных.");
  } catch (error) {
    console.error("Ошибка при загрузке состояния пользователей:", error);
  }
}

// Обработка сообщения "да"
bot.hears("Дать таблетку 🐾", async (ctx) => {
  const userId = ctx.from.id;

  if (!userState[userId]) {
    return ctx.reply("Начните работу с ботом командой /start.", menuKeyboard);
  }

  const currentHour = new Date().getHours();
  let timeSlot;

  if (currentHour >= 6 && currentHour < 14) {
    timeSlot = "morning";
  } else if (currentHour >= 14 && currentHour < 18) {
    timeSlot = "afternoon";
  } else if (currentHour >= 18) {
    timeSlot = "evening";
  } else {
    ctx.reply("Сейчас не время для напоминания.");
    return;
  }

  try {
    userState[userId].lastTaken[timeSlot] = true;
    await saveDose(userId, timeSlot);
    ctx.reply(`Отлично! Запомнил, что таблетка была дана в ${timeSlot}.`);
  } catch (error) {
    console.error("Ошибка при обработке сообщения:", error);
    ctx.reply("Произошла ошибка. Пожалуйста, попробуйте снова.");
  }
});

// Сохранение дозы в базу данных
async function saveDose(userId, timeSlot) {
  const today = new Date().toISOString().split("T")[0];

  try {
    const checkQuery = `
      SELECT * FROM statistics 
      WHERE user_id = $1 AND data = $2
    `;
    const result = await dbClient.query(checkQuery, [userId, today]);

    if (result.rowCount === 0) {
      const insertQuery = `
        INSERT INTO statistics (user_id, data, morning, afternoon, evening)
        VALUES ($1, $2, $3, $4, $5)
      `;
      await dbClient.query(insertQuery, [userId, today, false, false, false]);
    }

    const updateQuery = `
      UPDATE statistics
      SET ${timeSlot} = TRUE
      WHERE user_id = $1 AND data = $2
    `;
    await dbClient.query(updateQuery, [userId, today]);
  } catch (error) {
    console.error("Ошибка при сохранении дозы:", error);
    throw error;
  }
}

// Проверка существования пользователя
async function checkUserExists(userId) {
  try {
    const query = "SELECT * FROM users WHERE id = $1";
    const result = await dbClient.query(query, [userId]);
    return result.rowCount > 0;
  } catch (error) {
    console.error("Ошибка при проверке пользователя:", error);
    throw error;
  }
}

// Отправка напоминаний
function sendReminder(timeSlot) {
  return async function () {
    try {
      const query = "SELECT id FROM users";
      const result = await dbClient.query(query);

      for (const row of result.rows) {
        const userId = row.id;
        const userExists = await checkUserExists(userId);

        if (userExists) {
          await bot.telegram.sendMessage(
            userId,
            `Не забудь дать таблетку коту! (${timeSlot})`
          );
        }
      }
    } catch (err) {
      console.error("Ошибка при отправке напоминания:", err);
    }
  };
}

// Проверка пропущенных доз
function checkMissedDoses() {
  return async function () {
    const today = new Date().toISOString().split("T")[0];

    try {
      const query = "SELECT id FROM users";
      const result = await dbClient.query(query);

      for (const row of result.rows) {
        const userId = row.id;

        if (!userState[userId]) {
          userState[userId] = {
            lastTaken: { morning: false, afternoon: false, evening: false },
          };
        }

        const doses = userState[userId].lastTaken;
        const missedSlots = [];

        if (!doses.morning) missedSlots.push("утром");
        if (!doses.afternoon) missedSlots.push("в обед");
        if (!doses.evening) missedSlots.push("вечером");

        if (missedSlots.length > 0) {
          const message = `Вы пропустили приём таблетки коту ${missedSlots.join(
            ", "
          )}. Не забудьте в следующий раз!`;
          await bot.telegram.sendMessage(userId, message);
        }

        await saveStatistics(userId, today, doses);
        userState[userId].lastTaken = {
          morning: false,
          afternoon: false,
          evening: false,
        };
      }
    } catch (error) {
      console.error("Ошибка при проверке пропущенных доз:", error);
    }
  };
}

// Сохранение статистики
async function saveStatistics(userId, data, doses) {
  try {
    const query = `
      INSERT INTO statistics (user_id, data, morning, afternoon, evening)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, data) DO UPDATE
      SET morning = EXCLUDED.morning,
          afternoon = EXCLUDED.afternoon,
          evening = EXCLUDED.evening
    `;
    await dbClient.query(query, [
      userId,
      data,
      doses.morning,
      doses.afternoon,
      doses.evening,
    ]);
  } catch (error) {
    console.error("Ошибка при сохранении статистики:", error);
    throw error;
  }
}

// Команда /stats
bot.hears("Показать статистику 📊", async (ctx) => {
  const userId = ctx.from.id;

  try {
    const query = `
      SELECT data, morning, afternoon, evening
      FROM statistics
      WHERE user_id = $1
      ORDER BY data DESC
    `;
    const result = await dbClient.query(query, [userId]);

    if (result.rowCount === 0) {
      return ctx.reply("У вас ещё нет статистики.");
    }

    let message = "Статистика:\n";
    result.rows.forEach((row) => {
      const date = row.data;
      const status = `Утро: ${row.morning ? "✅" : "❌"}, Обед: ${
        row.afternoon ? "✅" : "❌"
      }, Вечер: ${row.evening ? "✅" : "❌"}`;
      message += `${date} - ${status}\n`;
    });

    ctx.reply(message);
  } catch (error) {
    console.error("Ошибка при получении статистики:", error);
    ctx.reply("Произошла ошибка. Пожалуйста, попробуйте снова.");
  }
});

// Планировщик напоминаний
scheduleJob("0 6 * * *", sendReminder("morning")); // В 6:00
scheduleJob("0 14 * * *", sendReminder("afternoon")); // В 14:00
scheduleJob("0 18 * * *", sendReminder("evening")); // В 18:00
scheduleJob("0 20 * * *", checkMissedDoses()); // В 20:00

// Запуск бота
loadUserStateFromDB()
  .then(() => {
    bot.launch();
    console.log("Бот запущен.");
  })
  .catch((err) => {
    console.error("Не удалось запустить бота:", err);
  });

// Обработка завершения работы
process.once("SIGINT", () => {
  dbClient
    .end()
    .then(() => console.log("Соединение с базой данных закрыто."))
    .catch((err) =>
      console.error("Ошибка при закрытии соединения с базой данных:", err)
    );
  bot.stop();
  console.log("Бот остановлен.");
});
