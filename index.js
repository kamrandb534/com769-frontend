const express = require('express');
const sql = require('mssql');
const azure = require('azure-storage');
const multer = require('multer');
const dotenv = require('dotenv');
const path = require('path');
const cors = require('cors'); // Add CORS for front-end

dotenv.config();
const app = express();
app.use(cors()); // Enable CORS
app.use(express.json());
const upload = multer({ dest: 'uploads/' });

const sqlConfig = {
    user: 'your_sql_admin_username', // From Azure SQL server
    password: 'your_sql_admin_password',
    server: 'your_sql_server.database.windows.net', // e.g., com769-server.database.windows.net
    database: 'com769-db',
    options: { encrypt: true }
};

const blobService = azure.createBlobService(process.env.BLOB_CONNECTION_STRING);

// In-memory cache (MVP scalability)
let mediaCache = null;
let cacheExpiry = 0;

// Get all media
app.get('/api/media', async (req, res) => {
    try {
        const now = Date.now();
        if (mediaCache && now < cacheExpiry) {
            return res.json(mediaCache);
        }

        let pool = await sql.connect(sqlConfig);
        let result = await pool.request().query(`
            SELECT m.*, u.Email AS CreatorEmail
            FROM Media m
            JOIN Users u ON m.UserId = u.UserId
        `);
        mediaCache = result.recordset;
        cacheExpiry = now + 60 * 1000; // Cache for 1 min
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get media by ID
app.get('/api/media/:id', async (req, res) => {
    try {
        let pool = await sql.connect(sqlConfig);
        let result = await pool.request()
            .input('MediaId', sql.Int, req.params.id)
            .query(`
                SELECT m.*, u.Email AS CreatorEmail
                FROM Media m
                JOIN Users u ON m.UserId = u.UserId
                WHERE m.MediaId = @MediaId
            `);
        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Media not found' });
        }
        res.json(result.recordset[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Upload media (Creator only)
app.post('/api/media', upload.single('file'), async (req, res) => {
    try {
        const { title, caption, location, people, userId } = req.body;
        const file = req.file;

        // Simulate auth
        let pool = await sql.connect(sqlConfig);
        let user = await pool.request()
            .input('UserId', sql.Int, userId)
            .query('SELECT Role FROM Users WHERE UserId = @UserId');
        if (user.recordset[0]?.Role !== 'Creator') {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        // Upload to Blob
        const blobName = `${Date.now()}-${file.originalname}`;
        await new Promise((resolve, reject) => {
            blobService.createBlockBlobFromLocalFile(
                'media-uploads',
                blobName,
                file.path,
                (err) => (err ? reject(err) : resolve())
            );
        });

        // Save metadata
        const blobUrl = `https://${blobService.storageAccountName}.blob.core.windows.net/media-uploads/${blobName}`;
        await pool.request()
            .input('UserId', sql.Int, userId)
            .input('Title', sql.NVarChar, title)
            .input('Caption', sql.NVarChar, caption)
            .input('Location', sql.NVarChar, location)
            .input('People', sql.NVarChar, people)
            .input('BlobUrl', sql.NVarChar, blobUrl)
            .query(`
                INSERT INTO Media (UserId, Title, Caption, Location, People, BlobUrl, UploadedAt)
                VALUES (@UserId, @Title, @Caption, @Location, @People, @BlobUrl, GETDATE())
            `);

        // Clear cache
        mediaCache = null;
        res.status(201).json({ message: 'Media uploaded', blobUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Add comment
app.post('/api/media/:id/comment', async (req, res) => {
    try {
        const { userId, commentText } = req.body;
        let pool = await sql.connect(sqlConfig);
        await pool.request()
            .input('MediaId', sql.Int, req.params.id)
            .input('UserId', sql.Int, userId)
            .input('CommentText', sql.NVarChar, commentText)
            .query(`
                INSERT INTO Comments (MediaId, UserId, CommentText, CreatedAt)
                VALUES (@MediaId, @UserId, @CommentText, GETDATE())
            `);
        res.status(201).json({ message: 'Comment added' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log('Server running');
});