// Checks a Telegram bot token, finds your chat ID, and sends a sample order notification.
// Usage: pnpm telegram:setup            (finds chats that have messaged the bot)
//        pnpm telegram:setup <chat-id>  (sends a sample notification to that chat)
// The token is read from the terminal (hidden) and is never written to disk.
import { createInterface } from 'node:readline';
import { formatOrderMessage, sendTelegramMessage } from '../worker/src/telegram.ts';

async function readToken(): Promise<string> {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  const prompt = 'Bot token from @BotFather: ';
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  // Hide typed characters.
  (terminal as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text) => {
    if (text.includes(prompt)) process.stderr.write(prompt);
  };
  const token = await new Promise<string>((resolve) => terminal.question(prompt, resolve));
  terminal.close();
  process.stderr.write('\n');
  return token.trim();
}

async function callApi<T>(token: string, method: string): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`);
  const body = (await response.json()) as { ok: boolean; result: T; description?: string };
  if (!body.ok)
    throw new Error(`Telegram ${method} failed (${response.status}): ${body.description}`);
  return body.result;
}

const token = await readToken();
const chatId = process.argv[2];

const bot = await callApi<{ username: string }>(token, 'getMe');
console.log(`Token OK: @${bot.username}`);

if (!chatId) {
  type Chat = { id: number; type: string; title?: string; first_name?: string; username?: string };
  const updates = await callApi<
    Array<{ message?: { chat: Chat }; my_chat_member?: { chat: Chat } }>
  >(token, 'getUpdates');
  const chats = new Map<number, Chat>();
  for (const update of updates) {
    const chat = update.message?.chat ?? update.my_chat_member?.chat;
    if (chat) chats.set(chat.id, chat);
  }
  if (chats.size === 0) {
    console.log(
      `\nNo chats yet. Open https://t.me/${bot.username}, tap Start, send "hi", then re-run.`,
    );
  } else {
    console.log('\nChats that have messaged the bot:');
    for (const chat of chats.values()) {
      const name =
        chat.title ??
        [chat.first_name, chat.username && `@${chat.username}`].filter(Boolean).join(' ');
      console.log(`  ${chat.id}  (${chat.type}) ${name}`);
    }
    console.log('\nNext: pnpm telegram:setup <chat-id>');
  }
} else {
  const text = formatOrderMessage(
    {
      details: {
        customerName: 'Test Customer',
        phone: '(512) 555-0142',
        street: '123 Example St',
        city: 'Austin',
        state: 'TX',
        zip: '78704',
        deliveryInstructions: 'This is a test notification.',
      },
      confirmation: {
        orderNumber: 'WFC-TEST00',
        totalBars: 3,
        totalCents: 600,
        items: [
          { productName: 'Caramel', quantity: 2, lineTotalCents: 400 },
          { productName: 'Almond', quantity: 1, lineTotalCents: 200 },
        ],
      },
    },
    process.env.ADMIN_URL ?? 'https://nicholasmackey.github.io/chocolate-fundraiser/admin',
  );
  const result = await sendTelegramMessage(token, chatId, text);
  if (!result.ok) {
    console.error(
      `Send failed (HTTP ${result.status}). Check the chat ID and that you tapped Start.`,
    );
    process.exit(1);
  }
  console.log('Sample notification sent. Check Telegram.');
  console.log(
    `Phone number is tappable: ${result.entityTypes.includes('phone_number') ? 'yes' : 'NO'}`,
  );
}
