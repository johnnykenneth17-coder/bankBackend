// ============================================================
// CORRECT PLACEMENT IN index.js
// ============================================================
// 
// Your file structure should follow this order:
//
//   1. require() / import statements
//   2. app = express()  +  middleware
//   3. Database pool setup
//   4. ← authenticateToken function defined HERE
//   5. ← Africa's Talking initialized HERE  
//   6. All your existing routes
//   7. ← PASTE THE TWO NEW ROUTES HERE  ✅
//   8. app.listen() / module.exports
//
// To find the right line: search your index.js for:
//   "app.listen" or "module.exports"
// and paste the routes JUST ABOVE that line.
//
// ============================================================
// PASTE THIS BLOCK just above your app.listen() or module.exports
// ============================================================

app.get('/api/user/face-descriptor', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;

    const result = await pool.query(
      'SELECT face_descriptor FROM users WHERE id = $1',
      [userId]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.face_descriptor) {
      return res.status(400).json({
        error: 'No face registered on this account. Please complete face registration first.',
      });
    }

    let descriptor = user.face_descriptor;
    if (typeof descriptor === 'string') {
      descriptor = JSON.parse(descriptor);
    }

    return res.json({ face_descriptor: descriptor });

  } catch (err) {
    console.error('[face-descriptor] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


app.post('/api/auth/face/audit', authenticateToken, async (req, res) => {
  try {
    const { matched, distance, similarity } = req.body;
    const userId = req.user.id || req.user.userId;

    await pool.query(
      `INSERT INTO face_audit_log (user_id, matched, distance, similarity, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        matched,
        distance,
        similarity,
        req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
      ]
    ).catch(() => {}); // Non-fatal

    return res.json({ ok: true });

  } catch (err) {
    return res.json({ ok: false });
  }
});