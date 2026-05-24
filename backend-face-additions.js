// ============================================================
// FACE VERIFICATION — BACKEND ADDITIONS FOR index.js
// ============================================================
// Place these routes in your index.js alongside your other routes.
// Requires: face-api.js is NOT needed on the server.
// All matching happens on the client.
// The server only stores/retrieves the descriptor and logs audits.
// ============================================================


// ── 1. GET /api/user/face-descriptor ──────────────────────────────────────────
// Returns the face descriptor stored during registration.
// The descriptor is a Float32Array serialised as a plain JSON number array.
// Client rehydrates it and does the matching locally.

app.get('/api/user/face-descriptor', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;

    // Fetch the stored descriptor from your users table.
    // Adjust the column/table name to match your schema.
    // Registration should store it in a column called `face_descriptor`
    // as a JSON array  (e.g. JSON.stringify(Array.from(descriptor))).
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

    // Parse if stored as a JSON string, pass through if already an array
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


// ── 2. POST /api/auth/face/audit ──────────────────────────────────────────────
// Lightweight audit log. No ML processing — just records the result.
// Non-blocking from client; failures are silently ignored on the client side.

app.post('/api/auth/face/audit', authenticateToken, async (req, res) => {
  try {
    const { matched, distance, similarity } = req.body;
    const userId = req.user.id || req.user.userId;

    // Optional: log to a face_audit_log table
    // CREATE TABLE face_audit_log (
    //   id         SERIAL PRIMARY KEY,
    //   user_id    INTEGER REFERENCES users(id),
    //   matched    BOOLEAN,
    //   distance   NUMERIC(6,4),
    //   similarity NUMERIC(6,4),
    //   ip_address TEXT,
    //   created_at TIMESTAMPTZ DEFAULT NOW()
    // );

    await pool.query(
      `INSERT INTO face_audit_log (user_id, matched, distance, similarity, ip_address)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        userId,
        matched,
        distance,
        similarity,
        req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
      ]
    ).catch(() => {}); // Non-fatal — table may not exist yet

    return res.json({ ok: true });
  } catch (err) {
    // Audit failure must never break the client
    return res.json({ ok: false });
  }
});


// ── REGISTRATION AMENDMENT ────────────────────────────────────────────────────
// If your registration endpoint already saves face_descriptor, no change needed.
// If not, add this to your POST /api/auth/register handler (inside the user INSERT):
//
//   const faceDescriptor = req.body.face_descriptor;  // array of 128 floats
//
//   INSERT INTO users (..., face_descriptor)
//   VALUES (..., $N)
//
//   Pass: JSON.stringify(faceDescriptor)   <-- stored as TEXT or JSONB column
//
// Add this column if it doesn't exist:
//   ALTER TABLE users ADD COLUMN IF NOT EXISTS face_descriptor JSONB;
//
// ─────────────────────────────────────────────────────────────────────────────


// ╔══════════════════════════════════════════════════════════════╗
// ║  OLD FACE API ENDPOINTS  —  COMMENT THESE OUT IN index.js   ║
// ╠══════════════════════════════════════════════════════════════╣
// ║                                                              ║
// ║  Search your index.js for these route patterns and wrap     ║
// ║  each one in /* ... */ to disable them:                     ║
// ║                                                              ║
// ║  1.  POST /auth/face/start-session                          ║
// ║      (created the verification session, called by old       ║
// ║       performFaceLogin step 1)                               ║
// ║                                                              ║
// ║  2.  POST /auth/face/verify                                 ║
// ║      (sent face_descriptor + final_image to backend,        ║
// ║       ran Python face comparison, returned { matched })     ║
// ║                                                              ║
// ║  3.  Any route that called out to a Python subprocess,      ║
// ║      or imported face_recognition / deepface / InsightFace  ║
// ║      or used child_process.spawn / exec with python         ║
// ║                                                              ║
// ║  Example — how to comment out:                              ║
// ║                                                              ║
// ║  /*                                                          ║
// ║  app.post('/auth/face/start-session', async (req, res) => { ║
// ║    ...your old code...                                       ║
// ║  });                                                         ║
// ║  */                                                          ║
// ║                                                              ║
// ║  /*                                                          ║
// ║  app.post('/auth/face/verify', async (req, res) => {        ║
// ║    ...your old code...                                       ║
// ║  });                                                         ║
// ║  */                                                          ║
// ║                                                              ║
// ╚══════════════════════════════════════════════════════════════╝
