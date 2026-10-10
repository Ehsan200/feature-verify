const users = [{ id: 1, email: 'a@b.c', password: 'pw', failed: 0 }];

export function verifyCredentials(email, password) {
  const user = users.find(u => u.email === email);
  if (!user) return { ok: false, reason: 'unknown' };
  if (user.password !== password) {
    user.failed++;
    return { ok: false, reason: 'bad-password' };
  }
  return { ok: true, token: 'tok-' + user.id, user: { id: user.id, email } };
}
