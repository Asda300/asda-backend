const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// ==========================================
// TSARON ASIRI (AUTHENTICATION)
// ==========================================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Access denied. No token provided." });

    jwt.verify(token, 'asda_sirrin_tsaro_key', (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid or expired token." });
        req.user = user;
        next();
    });
};

// ==========================================
// USER AUTHENTICATION & WALLET ROUTES
// ==========================================
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
        res.status(500).json({ error: "Registration failed." });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ error: "Invalid credentials." });
        }
        const token = jwt.sign({ id: user.id }, 'asda_sirrin_tsaro_key', { expiresIn: '24h' });
        res.json({ message: "Login successful!", token, user: { id: user.id, fullName: user.fullName, email: user.email } });
    } catch (error) {
        res.status(500).json({ error: "Login failed." });
    }
});

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
// ADMIN DASHBOARD ROUTE (SABO)
// ==========================================
app.get('/api/admin/dashboard', authenticateToken, async (req, res) => {
    try {
        // 1. Kidaya dukkan mutanen da suka yi rajista
        const totalUsers = await prisma.user.count();

        // 2. Kidaya jimullar kudin da ke cikin Wallet din kowa
        const walletAgg = await prisma.wallet.aggregate({ _sum: { balance: true } });
        const totalWalletBalance = walletAgg._sum.balance || 0;

        // 3. Kidaya jimullar sayayyar da aka yi a App din gaba daya
        const txAgg = await prisma.transaction.aggregate({ 
            _sum: { amount: true },
            where: { type: { not: 'FUND_WALLET' } } // Bamu hada da kudin da aka saka a wallet ba, sai wanda aka kashe
        });
        const totalSales = txAgg._sum.amount || 0;

        // 4. Dauko sababbin sayayya guda 20 na kowa da kowa
        const recentTransactions = await prisma.transaction.findMany({
            orderBy: { createdAt: 'desc' },
            take: 20,
            include: { user: { select: { fullName: true, email: true } } }
        });

        res.json({
            totalUsers,
            totalWalletBalance,
            totalSales,
            recentTransactions
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch admin data." });
    }
});

// ==========================================
// REAL API INTEGRATION LAYER
// ==========================================
const callExternalVTUProvider = async (serviceDetails) => {
    // Jinkirin gwaji domin ya yi kama da ainihin Intanet
    await new Promise(resolve => setTimeout(resolve, 1500));
    return { status: "DELIVERED", providerReference: "EXT-" + Math.floor(Math.random() * 900000000) };
};

const processPayment = async (userId, cost, description, referencePrefix, serviceDetails) => {
    const userWallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!userWallet || userWallet.balance < cost) throw new Error("Insufficient Wallet Balance.");

    const apiResponse = await callExternalVTUProvider(serviceDetails);

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

    return { updatedWallet, transaction, externalRef: apiResponse.providerReference };
};

// ==========================================
// CORE VTU SERVICES ROUTES
// ==========================================
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

app.post('/api/pay-electricity', authenticateToken, async (req, res) => {
    try {
        const { provider, meterNumber, amount } = req.body;
        const result = await processPayment(req.user.id, amount, `${provider} ELECTRICITY - ${meterNumber}`, 'ELE', { type: 'electricity', provider, meterNumber, amount });
        const tokenDisplay = Math.floor(1000000000000000 + Math.random() * 9000000000000000).toString().match(/.{1,4}/g).join('-');
        res.json({ message: `Electricity payment successful! Token: ${tokenDisplay}`, token: tokenDisplay, newBalance: result.updatedWallet.balance });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/pay-cable', authenticateToken, async (req, res) => {
    try {
        const { provider, smartCardNumber, plan, amount } = req.body;
        const result = await processPayment(req.user.id, amount, `${provider} TV (${plan}) - ${smartCardNumber}`, 'CAB', { type: 'cable', provider, smartCardNumber, plan });
        res.json({ message: `Successfully subscribed to ${plan}`, newBalance: result.updatedWallet.balance });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/buy-exam-pin', authenticateToken, async (req, res) => {
    try {
        const { examType, quantity, amount } = req.body;
        const result = await processPayment(req.user.id, amount, `${examType} EXAM PIN`, 'EXM', { type: 'exam', examType, quantity });
        const generatedPins = Array.from({length: quantity}, () => Math.random().toString(36).substring(2, 12).toUpperCase());
        res.json({ message: `Successfully purchased ${examType} pin`, pins: generatedPins, newBalance: result.updatedWallet.balance });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server is running on: http://localhost:${PORT}`));