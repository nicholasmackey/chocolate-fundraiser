// Prints a PBKDF2 hash for ADMIN_PASSWORD_HASH. Usage: pnpm hash-password
// The password is read from the terminal (hidden) or from stdin when piped.
import { createInterface } from 'node:readline';
import { hashPassword } from '../worker/src/crypto.ts';

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  }
  const prompt = 'Admin password: ';
  // The prompt goes to stderr so stdout can be piped straight into `wrangler secret put`.
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  // Hide typed characters.
  (terminal as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text) => {
    if (text.includes(prompt)) process.stderr.write(prompt);
  };
  const password = await new Promise<string>((resolve) => terminal.question(prompt, resolve));
  terminal.close();
  process.stderr.write('\n');
  return password;
}

const password = await readPassword();
if (password.length < 12) {
  process.stderr.write('Please use a password of at least 12 characters.\n');
  process.exit(1);
}
process.stdout.write(`${await hashPassword(password)}\n`);
