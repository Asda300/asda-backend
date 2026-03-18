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

// ==========================================
// 1. BABBAN SHAFIN API (HOME ROUTE)
// ==========================================
// Wannan zai gyara "Cannot GET /"
app.get('/', (req, res) => {
    res.json({
        message: "ASDA Digital Hub API is Live! 🚀",
        status: "Running",
        author: "ASDA Team"
    });
});

// ==========================================
// TSARON ASIRI (AUTHENTICATION MIDDLEWARE)
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
// USER AUTHENTICATION ROUTES
// ==========================================

// REGISTER
app.post('/api/register', async (req, res) => {
    try {
        const { fullName, email, password, phone } = req.body;
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) return res.status(400).json({ error: "Email already in use!" });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = await prisma.user.create({
            data: {
                fullName, email, password: hashedPassword, phone,
                wallet: { create: { balance: 0.0 } }
            }
        });
        res.status(201).json({ message: "Registration successful!", user: newUser });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Registration failed." });
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

// GET USER DATA
app.get('/api/user/me', authenticateToken, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            include: { wallet: true, transactions: { orderBy: { createdAt: 'desc' }, take: 15 } }
        });
        res.json({
            fullName: user.fullName, email: user.email, phone: user.phone,
            balance: user.wallet ? user.wallet.balance : 0.0,
            transactions: user.transactions
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch user data." });
    }
});

// FUND WALLET
app.post('/api/fund-wallet', authenticateToken, async (req, res) => {
    try {
        const { amount } = req.body;
        const fundAmount = parseFloat(amount);
        if (!fundAmount || fundAmount <= 0) return res.status(400).json({ error: "Invalid amount." });

        const updatedWallet = await prisma.wallet.update({
            where: { userId: req.user.id },
            data: { balance: { increment: fundAmount } }
        });

        const newTransaction = await prisma.transaction.create({
            data: { userId: req.user.id, type: 'FUND_WALLET', amount: fundAmount, status: 'SUCCESS', reference: 'FND-' + Date.now() }
        });
        res.json({ message: "Wallet funded successfully!", newBalance: updatedWallet.balance, transaction: newTransaction });
    } catch (error) {
        res.status(500).json({ error: "Failed to fund wallet." });
    }
});

// ==========================================
// ADMIN DASHBOARD ROUTE
// ==========================================
app.get('/api/admin/dashboard', authenticateToken, async (req, res) => {
    try {
        const totalUsers = await prisma.user.count();
        const walletAgg = await prisma.wallet.aggregate({ _sum: { balance: true } });
        const totalWalletBalance = walletAgg._sum.balance || 0;

        const txAgg = await prisma.transaction.aggregate({ 
            _sum: { amount: true },
            where: { type: { not: 'FUND_WALLET' } }
        });
        const totalSales = txAgg._sum.amount || 0;

        const recentTransactions = await prisma.transaction.findMany({
            orderBy: { createdAt: 'desc' },
            take: 20,
            include: { user: { select: { fullName: true, email: true } } }
        });

        res.json({ totalUsers, totalWalletBalance, totalSales, recentTransactions });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch admin data." });
    }
});

// ==========================================
// REAL API INTEGRATION LAYER (Simulation)
// ==========================================
const processPayment = async (userId, cost, description, referencePrefix, serviceDetails) => {
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

// CORE VTU ROUTES
app.post('/api/buy-airtime', authenticateToken, async (req, res) => {
    try {
        const { network, phone, amount } = req.body;
        const result = await processPayment(req.user.id, amount, `${network} AIRTIME - ${phone}`, 'AIR', { type: 'airtime', network, phone, amount });
        res.json({ message: `Successfully purchased ₦${amount} ${network} airtime`, newBalance: result.updatedWallet.balance });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/buy-data', authenticateToken, async (req, res) => {
    try {
        const { network, phone, plan, amount } = req.body;
        const result = await processPayment(req.user.id, amount, `${network} DATA (${plan}) - ${phone}`, 'DAT', { type: 'data', network, phone, plan });
        res.json({ message: `Successfully purchased ${plan} ${network} data`, newBalance: result.updatedWallet.balance });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// PORT SETTINGS
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server is running on port: ${PORT}`);
});
