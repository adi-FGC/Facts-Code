/**
 * Unit tests for the user model. A naive path-grep for "user" reads this file
 * in full even though changing the model rarely requires it up front.
 */
import { findUser, findUserByEmail, listUsers, saveUser, type User } from './user';

function fixture(id: string): User {
  return { id, email: `${id}@example.com`, displayName: `User ${id}`, createdAtMs: 0 };
}

export async function runUserModelTests(): Promise<string[]> {
  const failures: string[] = [];
  await saveUser(fixture('u1'));
  await saveUser(fixture('u2'));
  if (!findUser('u1')) failures.push('findUser misses a saved user');
  if (!findUserByEmail('u2@example.com')) failures.push('findUserByEmail misses a saved user');
  if (listUsers().length !== 2) failures.push('listUsers should return every saved user');
  const ordered = listUsers().map((u) => u.id);
  if (ordered.join(',') !== 'u1,u2') failures.push('listUsers must sort by id for stable pagination');
  await saveUser({ ...fixture('u1'), displayName: 'Renamed' });
  if (listUsers().length !== 2) failures.push('saveUser must upsert, not duplicate');
  if (findUser('u1')?.displayName !== 'Renamed') failures.push('saveUser must replace fields on upsert');
  return failures;
}
