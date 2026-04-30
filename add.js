// api/cron/process-savings.js
const { processAllSavings } = require('../services/savings-cron');

export default async function handler(req, res) {
    // Verify cron secret for security
    const authHeader = req.headers.authorization;
    const expectedSecret = process.env.CRON_SECRET;
    
    // Skip auth check if no secret is set (development) or verify in production
    if (expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
        console.log('Unauthorized cron attempt');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    console.log('Cron job triggered at:', new Date().toISOString());
    
    try {
        await processAllSavings();
        res.status(200).json({ 
            success: true, 
            message: 'Savings processed successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Cron job error:', error);
        res.status(500).json({ 
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
}