const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const prisma = new PrismaClient();

// Kyale kowa ya iya tuntuɓar API din (CORS)
app.use(cors());
app.use(express.json());

// --- MONNIFY CONFIGURATION (Daga Environment Variables) ---
const MONNIFY_BASE_URL = process.env.MONNIFY_BASE_URL || "https://sandbox.monnify.com";
const MONNIFY_API_KEY = process.env.MONNIFY_API_KEY;
const MONNIFY_SECRET_KEY = process.env.MONNIFY_SECRET_KEY;
const MONNIFY_CONTRACT_CODE = process.env.MONNIFY_CONTRACT_CODE;

// ==========================================
// 1. HOME ROUTE
// ==========================================
app.get('/', (req, res) => {
    res.json({
        message: "ASDA Digital Hub API is Live with Monnify! 🚀",
        status: "Running",
        author: "ASDA Team"
    });
});

// ==========================================
// 2. MONNIFY HELPER FUNCTIONS
// ==========================================

// A. Samo Token daga Monnify
const getMonnifyToken = async () => {
    try {
        const auth = Buffer.from(`${MONNIFY_API_KEY}:${MONNIFY_SECRET_KEY}`).toString('base64');
        const response = await fetch(`${MONNIFY_BASE_URL}/api/v1/auth/login`, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${auth}` }
        });
        const data = await response.json();
        if (!data.requestSuccessful) throw new Error("Monnify Authentication Failed");
        return data.responseBody.accessToken;
    } catch (error) {
        console.error("Monnify Token Error:", error);
        throw error;
    }
};

// B. Samar da Virtual Account
const generateVirtualAccount = async (user, token) => {
    try {
        const response = await fetch(`${MONNIFY_BASE_URL}/api/v1/bank-transfer/reserved-accounts`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                accountReference: `ASDA-${Date.now()}-${user.email.split('@')[0]}`,
                accountName: user.fullName,
                currencyCode: "NGN",
                contractCode: MONNIFY_CONTRACT_CODE,
                customerEmail: user.email,
                customerName: user.fullName,
                getAllAvailableBanks: true
            })
        });
        const data = await response.json();
        if (!data.requestSuccessful) throw new Error(data.responseMessage || "Failed to generate account");
        return data.responseBody.accounts[0]; // Muna daukar banki na farko
    } catch (error) {
        console.error("Monnify Account Error:", error);
        throw error;
    }
};

// ==========================================
// 3. TSARON ASIRI (AUTHENTICATION MIDDLEWARE)
// ==========================================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ error: "Access denied. No token provided." });

    jwt.verify(token, process.env.JWT_SECRET || 'asda_sirrin_tsaro_key', (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid or expired token." });
        req.user = user;
        next();
    });
};

// ==========================================
// 4. USER AUTHENTICATION ROUTES
// ==========================================

// REGISTER (Tare da Monnify Integration)
app.post('/api/register', async (req, res) => {
    try {
        const { fullName, email, password, phone } = req.body;
        
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) return res.status(400).json({ error: "Email already in use!" });

        // 1. Boye Password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // 2. Samo Virtual Account daga Monnify
        const token = await getMonnifyToken();
        const vAccount = await generateVirtualAccount({ fullName, email }, token);

        // 3. Adana User da Wallet dinsa
        const newUser = await prisma.user.create({
            data: {
                fullName, email, password: hashedPassword, phone,
                wallet: { 
                    create: { 
                        balance: 0.0,
                        bankName: vAccount.bankName,
                        accountNumber: vAccount.accountNumber,
                        accountName: vAccount.accountName
                    } 
                }
            }
        });
        
        res.status(201).json({ message: "Registration successful!", user: newUser });
    } catch (error) {
        console.error("Registration Error:", error);
        res.status(500).json({ error: error.message || "Registration failed." });
    }
});

// LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ error: "Invalid credentials." });
        }
        
        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET || 'asda_sirrin_tsaro_key', { expiresIn: '24h' });
        
        res.json({ 
            message: "Login successful!", 
            token, 
            user: { id: user.id, fullName: user.fullName, email: user.email } 
        });
    } catch (error) {
        res.status(500).json({ error: "Login failed." });
    }
});

// GET USER DATA (Don Dashboard)
app.get('/api/user/me', authenticateToken, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            include: { wallet: true, transactions: { orderBy: { createdAt: 'desc' }, take: 15 } }
        });
        
        res.json({
            fullName: user.fullName, 
            email: user.email, 
            phone: user.phone,
            balance: user.wallet ? user.wallet.balance : 0.0,
            bankName: user.wallet?.bankName || "Not Assigned",
            accountNumber: user.wallet?.accountNumber || "Not Assigned",
            accountName: user.wallet?.accountName || "Not Assigned",
            transactions: user.transactions
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch user data." });
    }
});

// ==========================================
// 5. VTU & WALLET LOGIC
// ==========================================

const processPayment = async (userId, cost, description, referencePrefix) => {
    const userWallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!userWallet || userWallet.balance < cost) throw new Error("Insufficient Wallet Balance.");

    const updatedWallet = await prisma.wallet.update({
        where: { userId },
        data: { balance: { decrement: cost } }
    });

    const transaction = await prisma.transaction.create({
        data: {
            userId, type: description, amount: cost, status: 'SUCCESS',
            reference: `${referencePrefix}-${Date.now()}`
        }
    });

    return { updatedWallet, transaction };
};

app.post('/api/buy-airtime', authenticateToken, async (req, res) => {
    try {
        const { network, phone, amount } = req.body;
        const result = await processPayment(req.user.id, amount, `${network} AIRTIME - ${phone}`, 'AIR');
        res.json({ message: `Successfully purchased ₦${amount} ${network} airtime`, newBalance: result.updatedWallet.balance });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// PORT SETTINGS
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server is running on port: ${PORT}`);
});
