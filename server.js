const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ============ 管理员账号 ============
const ADMIN_ACCOUNT = 'Zjcu201120withu';
const ADMIN_PASSWORD = 'Lyb201120';

// ============ 数据存储 ============
let members = {}; // {socketId: {id, name, password, balance, vip}}
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

const START_CHIPS = 1000;

io.on('connection', (socket) => {
    console.log('连接:', socket.id);

    // ============ 注册 ============
    socket.on('register', (data) => {
        const { name, password } = data;
        const exists = Object.values(members).find(m => m.name === name);
        if (exists) { socket.emit('error', '用户名已存在'); return; }
        const id = uuidv4().substring(0, 8).toUpperCase();
        members[socket.id] = { id, name, password, balance: 0, vip: false };
        socket.emit('registerSuccess', { id, name, balance: 0 });
        broadcastMembers();
    });

    // ============ 登录 ============
    socket.on('login', (data) => {
        const { account, password, name } = data;
        // 管理员登录
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
        // 会员登录
        const member = Object.values(members).find(m => m.name === name && m.password === password);
        if (!member) { socket.emit('error', '用户名或密码错误'); return; }
        // 更新socketId
        const oldKey = Object.keys(members).find(k => members[k].id === member.id);
        if (oldKey) delete members[oldKey];
        members[socket.id] = member;
        socket.emit('loginSuccess', { role: 'player', id: member.id, name: member.name, balance: member.balance, vip: member.vip });
        broadcastMembers();
        broadcastGameState();
    });

    // ============ 下注 ============
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
        socket.emit('betSuccess', `下注成功：${type === 'banker' ? '庄' : type === 'player' ? '闲' : '和'} ${amount}`);
    });

    // ============ 管理员功能 ============
    socket.on('recharge', (data) => {
        if (socket.id !== gameState.hostSocketId) return;
        const { playerId, amount } = data;
        const target = Object.entries(members).find(([_, m]) => m.id === playerId);
        if (target) {
            target[1].balance += parseInt(amount);
            const targetSid = target[0];
            io.to(targetSid).emit('balanceUpdate', target[1].balance);
            socket.emit('rechargeSuccess', `成功给 ${target[1].name} 充值 ${amount}`);
            broadcastMembers();
        }
    });

    socket.on('deduct', (data) => {
        if (socket.id !== gameState.hostSocketId) return;
        const { playerId, amount } = data;
        const target = Object.entries(members).find(([_, m]) => m.id === playerId);
        if (target) {
            target[1].balance -= parseInt(amount);
            const targetSid = target[0];
            io.to(targetSid).emit('balanceUpdate', target[1].balance);
            socket.emit('rechargeSuccess', `成功从 ${target[1].name} 扣除 ${amount}`);
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
        socket.emit('presetConfirm', `已设定：${result === 'banker' ? '庄赢' : result === 'player' ? '闲赢' : '和局'}`);
    });

    socket.on('clearPreset', () => {
        if (socket.id !== gameState.hostSocketId) return;
        gameState.presetWinner = null;
        socket.emit('presetConfirm', '已恢复随机');
    });

    socket.on('changeRoom', (room) => {
        if (socket.id !== gameState.hostSocketId) return;
        gameState.currentRoom = room;
        broadcastGameState();
    });

    // ============ 发牌 ============
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

    // ============ 断开 ============
    socket.on('disconnect', () => {
        if (socket.id === gameState.hostSocketId) gameState.hostSocketId = null;
        broadcastMembers();
    });
});

// ============ 工具函数 ============
function randomCard() {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    return {
        suit: suits[Math.floor(Math.random() * 4)],
        value: values[Math.floor(Math.random() * 13)],
        get display() { return this.value + this.suit; }
    };
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
        bets: gameState.bets,
        roundActive: gameState.roundActive,
        bankerCards: gameState.bankerCards,
        playerCards: gameState.playerCards,
        result: gameState.result,
        presetWinner: gameState.presetWinner,
        currentRoom: gameState.currentRoom,
        roomLimit: gameState.roomLimits[gameState.currentRoom],
        hostOnline: !!gameState.hostSocketId
    });
}

function broadcastMembers() {
    const list = Object.values(members).map(m => ({ id: m.id, name: m.name, balance: m.balance, vip: m.vip }));
    io.emit('membersList', list);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('皇家百家乐启动在端口:', PORT);
});
