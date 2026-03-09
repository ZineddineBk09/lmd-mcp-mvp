import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connectMongoDB } from './connections/mongodb.js';
import { createMcpServer, initAuthContext } from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, '..', '.env') });

async function main() {
  await connectMongoDB();

  const authContext = await initAuthContext();
  const server = createMcpServer({ authContext });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error starting MCP server:', err);
  process.exit(1);
});
