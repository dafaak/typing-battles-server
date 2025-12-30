import express from 'express';
import { createServer } from 'http';
import { Server as WS_Server, Socket } from 'socket.io';
import { faker } from '@faker-js/faker';

const gameTimers: { [key: string]: NodeJS.Timeout } = {};

type Player = {
  conn_id: string,
  name: string,
  score: number,
  progress?: number,
  place?: number,
  is_ready: boolean,
  room?: string,
};

interface JoinRoom {
  name: string
  room: string
}

interface Party {
  name: string,
  players: Player[]
  state: "loby" | "ready" | "running" | "finished" | "preparing" | "starting"
  targetString?: string
  timer?: number
  finished?: boolean
}

const parties: { [key: string]: Party } = {};

class Server {
  players: Player[] = [];
  io: WS_Server;

  constructor() {
    const app = express();
    const server = createServer(app);

    this.io = new WS_Server(server, {
      cors: {
        origin: "*", // En producción, cambiar "*" por "https://tu-usuario.github.io"
        methods: ["GET", "POST"]
      }
    });

    this.io.on('connection', (ws: Socket) => this.onConnect(ws));

    // Railway usa la variable de entorno PORT
    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => {
      console.log(`Server is listening on port ${PORT}`);
    });
  }

  onConnect(ws: Socket) {
    const player: Player = {
      conn_id: ws.id,
      name: "Anonymous",
      score: 0,
      is_ready: false,
    };
    this.players.push(player);

    ws.emit('res_conn', { party_state: 'lobby', player });

    ws.on('message', (data) => this.onMessage(data, ws));
    ws.on('join-room', (data) => this.onJoinRoom(ws, data));
    ws.on('disconnect', () => this.onDisconnect(ws));
  }

  onDisconnect(ws: Socket) {
    const playerDisconnected = this.findPlayerByCoonId(ws.id);
    this.players = this.players.filter((p) => p.conn_id !== ws.id);

    if (playerDisconnected?.room) {
      const party = parties[playerDisconnected.room];
      if (party) {
        party.players = party.players.filter((p) => p.conn_id !== ws.id);

        if (party.players.length === 0) {
          if (gameTimers[playerDisconnected.room]) {
            clearTimeout(gameTimers[playerDisconnected.room]);
            delete gameTimers[playerDisconnected.room];
          }
          delete parties[playerDisconnected.room];
        } else {
          this.io.to(playerDisconnected.room).emit('game-update', JSON.stringify(party));
        }
      }
    }
  }

  onJoinRoom(ws: Socket, data: any) {

    const joinRoom: JoinRoom = typeof data === 'string' ? JSON.parse(data) : data;

    ws.join(joinRoom.room);
    const player = this.updatePlayer(ws.id, joinRoom);
    const party = this.joinPartie(joinRoom, ws.id);

    ws.emit('join-room-success', JSON.stringify(player));
    if (party) {
      this.io.to(joinRoom.room).emit('game-update', JSON.stringify(party));
    }
  }

  findPlayerIndex(conn_id: string): number | undefined {
    const index = this.players.findIndex(p => p.conn_id === conn_id);
    return index >= 0 ? index : undefined;
  }

  findPlayerByCoonId(conn_id: string): Player | undefined {
    return this.players.find(p => p.conn_id === conn_id);
  }

  findPlayerInParty(room: string, conn_id: string): Player | undefined {
    return parties[room]?.players.find(p => p.conn_id === conn_id);
  }

  joinPartie(joinRoom: JoinRoom, conn_id: string): Party | undefined {
    const player = this.findPlayerByCoonId(conn_id);
    if (!player) return undefined;

    if (!parties[joinRoom.room]) {
      parties[joinRoom.room] = {
        players: [],
        state: "loby",
        name: joinRoom.room
      };
    }

    const party = parties[joinRoom.room];
    const exists = party.players.find(p => p.conn_id === conn_id);
    if (!exists) {
      party.players.push({ ...player, room: joinRoom.room });
    }

    return party;
  }

  updatePlayer(conn_id: string, data: JoinRoom) {
    const index = this.players.findIndex(p => p.conn_id === conn_id);
    if (index >= 0) {
      this.players[index] = { ...this.players[index], ...data, room: data.room };
      return this.players[index];
    }
    return undefined;
  }

  onMessage(rawMessage: any, sender: Socket) {
    const data = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;
    const { event, message } = data;
    const room = message?.room;

    if (!room || !parties[room]) return;

    const currentParty = parties[room];

    if (event === "update_user_progress") {
      const player = this.findPlayerInParty(room, sender.id);
      if (player) {
        player.progress = message.progress;
        if (player.progress === 100 && !player.place) {
          this.setPlayerPlace(room, sender.id);
        }
      }
    }

    if (event === "update_user_state") {
      const player = this.findPlayerInParty(room, sender.id);
      if (player) {
        player.is_ready = message.is_ready;
        const allReady = currentParty.players.every(p => p.is_ready);
        currentParty.state = allReady ? "ready" : "loby";
      }
    }

    if (event === "start-game") {
      currentParty.state = "starting";
    }

    this.mirror({ socket: sender, room, partie: currentParty });
  }

  setPlayerPlace(room: string, conn_id: string) {
    const party = parties[room];
    const place = party.players.filter(p => p.place).length + 1;
    const player = party.players.find(p => p.conn_id === conn_id);
    if (player) player.place = place;
  }

  setPlayersPlaceAndScore(room: string) {
    const party = parties[room];

    party.players
        .sort((a, b) => (b.progress || 0) - (a.progress || 0))
        .forEach((p, i) => {
          if (!p.place) p.place = i + 1;
        });
  }

  resetPlaceProgress(room: string) {
    parties[room]?.players.forEach(p => {
      p.place = undefined;
      p.progress = 0;
    });
  }

  mirror(params: { socket: Socket, room: string, partie: Party }) {
    const { room, partie } = params;

    switch (partie.state) {
      case "ready":
        this.resetPlaceProgress(room);
        partie.targetString = faker.word.words({ count: 12 });
        partie.timer = 30000;
        break;

      case "starting":
        partie.state = 'running';
        if (gameTimers[room]) clearTimeout(gameTimers[room]);

        // Timer de 30 segundos para el juego
        gameTimers[room] = setTimeout(() => {
          if (parties[room]) {
            parties[room].state = 'finished';
            this.setPlayersPlaceAndScore(room);
            // EMISIÓN ACTIVA: Esto soluciona el bug de navegación
            this.io.to(room).emit('game-update', JSON.stringify(parties[room]));
            delete gameTimers[room];
          }
        }, 30000);
        break;
    }

    this.io.to(room).emit('game-update', JSON.stringify(partie));
  }
}

new Server();