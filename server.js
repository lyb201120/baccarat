const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_ACCOUNT = 'Zjcu201120withu';
const ADMIN_PASSWORD = 'Lyb201120';

// ============ API 配置 ============
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const ODDS_API_URL = 'https://api.the-odds-api.com/v4/sports';

let members = {};
let sportsOdds = [];
let lastOddsUpdate = null;

let gameState = {
    bets: {},
    roundActive: false,
    bankerCards: [],
    playerCards: [],
    result: null,
    hostSocketId: null,
    presetWinner: null,
    roomLimits: { A: 1000, B: 5000, VIP: 50000 },
    currentRoom: 'A'
};

// ============ API 路由 ============
app.get('/api/odds', async (req, res) => {
    if (sportsOdds.length > 0) {
        return res.json(sportsOdds);
    }
    if (ODDS_API_KEY) {
        try {
            const response = await axios.get(`${ODDS_API_URL}/soccer_epl/odds`, {
                params: { apiKey: ODDS_API_KEY, regions: 'eu', markets: 'h2h', oddsFormat: 'decimal' }
            });
            sportsOdds = response.data.map(m => ({
                home: m.home_team,
                away: m.away_team,
                odds: {
                    home: m.bookmakers[0]?.markets[0]?.outcomes[0]?.price || '-',
                    draw: m.bookmakers[0]?.markets[0]?.outcomes[1]?.price || '-',
                    away: m.bookmakers[0]?.markets[0]?.outcomes[2]?.price || '-'
                }
            }));
            lastOddsUpdate = new Date();
            res.json(sportsOdds);
        } catch (e) {
            res.json([]);
        }
    } else {
        res.json([]);
    }
});

app.get('/api/sync-odds', async (req, res) => {
    if (!ODDS_API_KEY) return res.json({ success: false, message: 'API Key未配置' });
    try {
        const response = await axios.get(`${ODDS_API_URL}/soccer_epl/odds`, {
            params: { apiKey: ODDS_API_KEY, regions: 'eu', markets: 'h2h', oddsFormat: 'decimal' }
        });
        sportsOdds = response.data.map(m => ({
            home: m.home_team,
            away: m.away_team,
            odds: {
                home: m.bookmakers[0]?.markets[0]?.outcomes[0]?.price || '-',
                draw: m.bookmakers[0]?.markets[0]?.outcomes[1]?.price || '-',
                away: m.bookmakers[0]?.markets[0]?.outcomes[2]?.price || '-'
            }
        }));
        lastOddsUpdate = new Date();
        res.json({ success: true, count: sportsOdds.length });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ============ Socket.io ============
io.on('connection', (socket) => {
    console.log('连接:', socket.id);

    socket.on('register', (data) => {
        const { name, password } = data;
        const exists = Object.values(members).find(m => m.name === name);
        if (exists) { socket.emit('error', '用户名已存在'); return; }
        const id = uuidv4().substring(0, 8).toUpperCase();
        members[socket.id] = { id, name, password, balance: 0, vip: false };
        socket.emit('registerSuccess', { id, name, balance: 0 });
        broadcastMembers();
    });

    socket.on('login', (data) => {
        const { account, password, name } = data;
        if (account === ADMIN_ACCOUNT && password === ADMIN_PASSWORD) {
            if (gameState.hostSocketId && gameState.hostSocketId !== socket.id) {
                socket.emit('error', '管理员已在其他地方登录');
                return;
            }
            gameState.hostSocketId = socket.id;
            members[socket.id] = { id: 'ADMIN', name: '管理员', balance: 999999, vip: true };
            socket.emit('loginSuccess', { role: 'admin', id: 'ADMIN', name: '管理员', balance: 999999 });
            broadcastMembers();
            broadcastGameState();
            return;
        }
        const member = Object.values(members).find(m => m.name === name && m.password === password);
        if (!member) { socket.emit('error', '用户名或密码错误'); return; }
        const oldKey = Object.keys(members).find(k => members[k].id === member.id);
        if (oldKey) delete members[oldKey];
        members[socket.id] = member;
        socket.emit('loginSuccess', { role: 'player', id: member.id, name: member.name, balance: member.balance, vip: member.vip });
        broadcastMembers();
        broadcastGameState();
    });

    socket.on('bet', (data) => {
        const member = members[socket.id];
        if (!member || gameState.roundActive) return;
        const amount = parseInt(data.amount);
        const type = data.type;
        if (!['banker', 'player', 'tie'].includes(type)) return;
        const limit = gameState.roomLimits[gameState.currentRoom];
        if (amount > limit) { socket.emit('error', `本厅限红${limit}`); return; }
        if (amount > member.balance || amount <= 0) { socket.emit('error', '余额不足'); return; }
        member.balance -= amount;
        gameState.bets[socket.id] = { type, amount };
        broadcastGameState();
    });

    socket.on('recharge', (data) => {
        if (socket.id !== gameState.hostSocketId) return;
        const { playerId, amount } = data;
        const target = Object.entries(members).find(([_, m]) => m.id === playerId);
        if (target) {
            target[1].balance += parseInt(amount);
            io.to(target[0]).emit('balanceUpdate', target[1].balance);
            broadcastMembers();
        }
    });

    socket.on('deduct', (data) => {
        if (socket.id !== gameState.hostSocketId) return;
        const { playerId, amount } = data;
        const target = Object.entries(members).find(([_, m]) => m.id === playerId);
        if (target) {
            target[1].balance -= parseInt(amount);
            io.to(target[0]).emit('balanceUpdate', target[1].balance);
            broadcastMembers();
        }
    });

    socket.on('setVip', (data) => {
        if (socket.id !== gameState.hostSocketId) return;
        const target = Object.entries(members).find(([_, m]) => m.id === data.playerId);
        if (target) { target[1].vip = data.vip; broadcastMembers(); }
    });

    socket.on('presetResult', (result) => {
        if (socket.id !== gameState.hostSocketId) return;
        gameState.presetWinner = result;
    });

    socket.on('clearPreset', () => {
        if (socket.id !== gameState.hostSocketId) return;
        gameState.presetWinner = null;
    });

    socket.on('changeRoom', (room) => {
        if (socket.id !== gameState.hostSocketId) return;
        gameState.currentRoom = room;
        broadcastGameState();
    });

    socket.on('deal', () => {
        if (gameState.roundActive) return;
        gameState.roundActive = true;
        gameState.bankerCards = [];
        gameState.playerCards = [];
        if (gameState.presetWinner) {
            const cards = generateCardsForResult(gameState.presetWinner);
            gameState.playerCards = cards.playerCards;
            gameState.bankerCards = cards.bankerCards;
        } else {
            gameState.playerCards = [randomCard(), randomCard()];
            gameState.bankerCards = [randomCard(), randomCard()];
        }
        broadcastGameState();
        setTimeout(() => {
            revealResult();
            gameState.presetWinner = null;
        }, 2000);
    });

    socket.on('disconnect', () => {
        if (socket.id === gameState.hostSocketId) gameState.hostSocketId = null;
        broadcastMembers();
    });
});

function randomCard() {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    return { suit: suits[Math.floor(Math.random() * 4)], value: values[Math.floor(Math.random() * 13)], get display() { return this.value + this.suit; } };
}

function calculatePoints(cards) {
    let total = 0;
    cards.forEach(card => {
        if (card.value === 'A') total += 1;
        else if (['J', 'Q', 'K', '10'].includes(card.value)) total += 0;
        else total += parseInt(card.value);
    });
    return total % 10;
}

function generateCardsForResult(winner) {
    let pc, bc, pp, bp;
    do {
        pc = [randomCard(), randomCard()]; bc = [randomCard(), randomCard()];
        pp = calculatePoints(pc); bp = calculatePoints(bc);
    } while ((winner === 'player' && pp <= bp) || (winner === 'banker' && bp <= pp) || (winner === 'tie' && pp !== bp));
    return { playerCards: pc, bankerCards: bc };
}

function revealResult() {
    const pp = calculatePoints(gameState.playerCards);
    const bp = calculatePoints(gameState.bankerCards);
    let winner = 'tie';
    if (pp > bp) winner = 'player';
    else if (bp > pp) winner = 'banker';
    gameState.result = { playerCards: gameState.playerCards, bankerCards: gameState.bankerCards, playerPoints: pp, bankerPoints: bp, winner };
    Object.keys(gameState.bets).forEach(sid => {
        const bet = gameState.bets[sid];
        const member = members[sid];
        if (!bet || !member) return;
        let mul = 0;
        if (bet.type === winner) mul = bet.type === 'tie' ? 8 : bet.type === 'banker' ? 1.95 : 2;
        else if (winner === 'tie') mul = 1;
        if (mul > 0) member.balance += Math.floor(bet.amount * mul);
    });
    broadcastGameState();
    broadcastMembers();
    setTimeout(() => {
        gameState.bets = {};
        gameState.roundActive = false;
        gameState.bankerCards = [];
        gameState.playerCards = [];
        gameState.result = null;
        broadcastGameState();
    }, 5000);
}

function broadcastGameState() {
    io.emit('gameState', {
        bets: gameState.bets, roundActive: gameState.roundActive,
        bankerCards: gameState.bankerCards, playerCards: gameState.playerCards,
        result: gameState.result, presetWinner: gameState.presetWinner,
        currentRoom: gameState.currentRoom, roomLimit: gameState.roomLimits[gameState.currentRoom],
        hostOnline: !!gameState.hostSocketId
    });
}

function broadcastMembers() {
    io.emit('membersList', Object.values(members).map(m => ({ id: m.id, name: m.name, balance: m.balance, vip: m.vip })));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('皇家百家乐启动:', PORT));
