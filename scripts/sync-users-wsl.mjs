import { DatabaseSync } from 'node:sqlite';

const dbPath = process.platform === 'win32'
  ? '\\\\wsl$\\Ubuntu\\home\\catzpro01\\.n8n\\database.sqlite'
  : '/home/catzpro01/.n8n/database.sqlite';
const db = new DatabaseSync(dbPath);

// Update primary owner to catzpro01@gmail.com
db.prepare('UPDATE user SET email = ? WHERE id = ?').run('catzpro01@gmail.com', 'dccf3219-09ba-4c8d-aee6-b0ebd7a57cae');

const owner = db.prepare('SELECT * FROM user WHERE id = ?').get('dccf3219-09ba-4c8d-aee6-b0ebd7a57cae');

// Also insert catzpro02@gmail.com as secondary admin
try {
  db.prepare(`
    INSERT OR REPLACE INTO user (id, email, firstName, lastName, password, personalizationAnswers, createdAt, updatedAt, settings, disabled, mfaEnabled, roleSlug)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'dccf3219-09ba-4c8d-aee6-b0ebd7a57caf',
    'catzpro02@gmail.com',
    'Admin',
    '02',
    owner.password,
    owner.personalizationAnswers,
    owner.createdAt,
    owner.updatedAt,
    owner.settings,
    0,
    0,
    'global:admin'
  );

  db.prepare(`
    INSERT OR REPLACE INTO project (id, name, type, createdAt, updatedAt, creatorId, customTelemetryTags)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    '6BERd9J8smAOytt1',
    'Admin 02 <catzpro02@gmail.com>',
    'personal',
    owner.createdAt,
    owner.updatedAt,
    'dccf3219-09ba-4c8d-aee6-b0ebd7a57caf',
    '[]'
  );

  db.prepare(`
    INSERT OR REPLACE INTO project_relation (projectId, userId, role, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    '6BERd9J8smAOytt1',
    'dccf3219-09ba-4c8d-aee6-b0ebd7a57caf',
    'project:personalOwner',
    owner.createdAt,
    owner.updatedAt
  );

  db.prepare(`
    INSERT OR REPLACE INTO project_relation (projectId, userId, role, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    '6BERd9J8smAOytt0',
    'dccf3219-09ba-4c8d-aee6-b0ebd7a57caf',
    'project:admin',
    owner.createdAt,
    owner.updatedAt
  );

  console.log('Successfully configured dual users in official n8n!');
} catch (e) {
  console.error('Error inserting secondary user:', e.message);
}

const allUsers = db.prepare('SELECT id, email, roleSlug FROM user').all();
console.log('All users in n8n reference:', allUsers);
