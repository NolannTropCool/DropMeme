import { readConfig } from './config.js';
import { registerCommand } from './discord.js';

await registerCommand(readConfig(process.env));
console.info('Commande /dropmeme enregistrée.');
