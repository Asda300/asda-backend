const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer'); // 1. Mun kara Nodemailer
require('dotenv').config();

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// --- CONFIGURATIONS ---
const MONNIFY_BASE_URL = process.env.MONNIFY_BASE_URL || "https://sandbox.monnify.com";
const MONNIFY_API_KEY = process.env.MONNIFY_API_KEY;
const MONNIFY_SECRET_KEY = process.env.MONNIFY_SECRET_KEY;
const MONNIFY_CONTRACT_CODE = process.env.MONNIFY_CONTRACT_CODE;

// 2. NODEMAILER TRANSPORTER SETUP
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER, // Sanya email dinka a .env
        pass: process.env.EMAIL_PASS  // Sanya App Password dinka a .env
    }
});

// ==========================================
// MONNIFY HELPER FUNCTIONS (Sun nan daram)
// ==========================================
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
        return data.responseBody.accounts[0];
    } catch (error) {
        console.error("Monnify Account Error:", error);
        throw error;
    }
};

// AUTH MIDDLEWARE
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
// USER AUTHENTICATION & FORGOT PASSWORD
// ==========================================

// A. REGISTER
app.post('/api/register', async (req, res) => {
    try {
        const { fullName, email, password, phone } = req.body;
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) return res.status(400).json({ error: "Email already in use!" });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const token = await getMonnifyToken();
        const vAccount = await generateVirtualAccount({ fullName, email }, token);

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
        res.status(500).json({ error: error.message || "Registration failed." });
    }
});

// B. LOGIN
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

// C. FORGOT PASSWORD - REQUEST OTP
app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return res.status(404).json({ error: "Email not found" });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        await prisma.user.update({
            where: { email },
            data: { 
                otp: otp, 
                otpExpiry: new Date(Date.now() + 15 * 60 * 1000) // Expiry: 15 mins
            }
        });

        const mailOptions = {
            from: `"ASDA Digital Hub" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: 'Password Reset Code',
            html: `<h3>Your Verification Code:</h3><h1 style="color:#2ecc71">${otp}</h1><p>Code expires in 15 minutes.</p>`
        };

        await transporter.sendMail(mailOptions);
        res.json({ message: "OTP sent to your email" });
    } catch (error) {
        res.status(500).json({ error: "Failed to send OTP" });
    }
});

// D. RESET PASSWORD - VERIFY & UPDATE
app.post('/api/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body;
    try {
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || user.otp !== otp || new Date() > user.otpExpiry) {
            return res.status(400).json({ error: "Invalid or expired OTP" });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        await prisma.user.update({
            where: { email },
            data: { 
                password: hashedPassword, 
                otp: null, 
                otpExpiry: null 
            }
        });

        res.json({ message: "Password updated successfully" });
    } catch (error) {
        res.status(500).json({ error: "Reset failed" });
    }
});

// ==========================================
// 5. VTU & OTHER ROUTES (Sun nan daram)
// ==========================================
app.get('/api/user/me', authenticateToken, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            include: { wallet: true, transactions: { orderBy: { createdAt: 'desc' }, take: 15 } }
        });
        res.json({
            fullName: user.fullName, email: user.email, phone: user.phone,
            balance: user.wallet?.balance || 0.0,
            bankName: user.wallet?.bankName || "Not Assigned",
            accountNumber: user.wallet?.accountNumber || "Not Assigned",
            accountName: user.wallet?.accountName || "Not Assigned",
            transactions: user.transactions
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch user data." });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port: ${PORT}`));
