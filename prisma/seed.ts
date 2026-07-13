import { createPrismaClient } from '../src/database/prisma-client.factory';
import { ensureDefaultData } from '../src/database/default-data';

const prisma = createPrismaClient();

ensureDefaultData(prisma)
  .then(() => {
    process.stdout.write(
      `${JSON.stringify({ event: 'database.seed.completed' })}\n`,
    );
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        event: 'database.seed.failed',
        error_message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
