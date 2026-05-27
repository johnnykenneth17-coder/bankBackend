// In your index.js, add to CORS config:
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Client-Version, X-Device-ID, X-Platform');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    // Android WebView specific
    if (req.headers['x-requested-with'] && req.headers['x-requested-with'].includes('android')) {
        res.header('X-Android-Received', 'true');
    }
    
    next();
});