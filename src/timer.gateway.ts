import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Match } from './match.entity';

@WebSocketGateway({ cors: true })
export class TimerGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(
    @InjectRepository(Match)
    private matchRepo: Repository<Match>,
  ) {}

  // ESTADO DO JOGO
  private timer: number = 60;
  private isRunning: boolean = false;
  private isPaused: boolean = false;
  private interval: NodeJS.Timeout | null = null;

  private viewMode: 'MATCH' | 'HISTORY' = 'HISTORY';

  private matchState = {
    nome1: '',
    nome2: '',
    score1: 0,
    score2: 0,
    round: 1,
    fase: 'preliminar',
  };

  // --- NOVO: FILAS DE ESPERA AUTOMÁTICAS ---
  // Armazena quem ganhou e está esperando o adversário
  private queues = {
    semi: [] as string[], // Vencedores das preliminares vêm pra cá
    final: [] as string[], // Vencedores das semis vêm pra cá
  };

  handleConnection(client: any) {
    this.broadcastState();
    this.sendHistory();
  }

  @SubscribeMessage('start-match')
  handleStartMatch(
    @MessageBody() data: { nome1: string; nome2: string; fase: string },
  ) {
    this.matchState = {
      nome1: data.nome1,
      nome2: data.nome2,
      score1: 0,
      score2: 0,
      round: 1,
      fase: data.fase || 'preliminar',
    };

    // Se iniciamos uma luta usando a fila, removemos os nomes da fila
    this.removeFromQueue(data.fase, data.nome1, data.nome2);

    this.timer = 60;
    this.viewMode = 'MATCH';
    this.startInterval();
    this.broadcastState();
  }

  @SubscribeMessage('end-match')
  async handleEndMatch() {
    this.stopTimer();

    // 1. Determina Vencedor
    let winner = '';
    // Lógica para Bye (sem oponente) ou placar normal
    if (
      !this.matchState.nome2 ||
      this.matchState.nome2 === '-' ||
      this.matchState.nome2 === ''
    ) {
      winner = this.matchState.nome1;
    } else {
      if (this.matchState.score1 > this.matchState.score2)
        winner = this.matchState.nome1;
      else if (this.matchState.score2 > this.matchState.score1)
        winner = this.matchState.nome2;
    }

    // 2. Lógica de Afunilamento (Automática)
    if (winner) {
      if (
        this.matchState.fase === 'preliminar' ||
        this.matchState.fase === 'quartas'
      ) {
        this.queues.semi.push(winner); // Promove para Semi
      } else if (this.matchState.fase === 'semi') {
        this.queues.final.push(winner); // Promove para Final
      }
    }

    // 3. Salva no Banco
    const match = this.matchRepo.create({
      nome1: this.matchState.nome1,
      nome2: this.matchState.nome2,
      score1: this.matchState.score1,
      score2: this.matchState.score2,
      fase: this.matchState.fase,
    });
    await this.matchRepo.save(match);

    this.viewMode = 'HISTORY';
    this.broadcastState();
    this.sendHistory();
  }

  @SubscribeMessage('delete-match')
  async handleDeleteMatch(@MessageBody() data: { id: number }) {
    await this.matchRepo.delete(data.id);
    this.sendHistory();
    // Nota: Deletar a match não remove automaticamente da fila (para evitar complexidade),
    // mas o Admin pode limpar a fila manualmente reiniciando o server se precisar.
  }

  // --- MÉTODOS DE CONTROLE (Padrão) ---

  @SubscribeMessage('next-round')
  handleNextRound() {
    this.matchState.round++;
    this.timer = 60;
    this.stopTimer();
    this.isPaused = true;
    this.broadcastState();
  }

  @SubscribeMessage('pause-match')
  handlePause() {
    this.stopTimer();
    this.isPaused = true;
    this.broadcastState();
  }

  @SubscribeMessage('resume-match')
  handleResume() {
    if (this.timer > 0 && !this.isRunning) {
      this.isPaused = false;
      this.startInterval();
    }
  }

  @SubscribeMessage('adjust-time')
  handleAdjustTime(@MessageBody() data: { seconds: number }) {
    this.timer += data.seconds;
    if (this.timer < 0) this.timer = 0;
    this.broadcastState();
  }

  @SubscribeMessage('update-score')
  handleUpdateScore(
    @MessageBody() data: { player: 1 | 2; action: 'add' | 'remove' },
  ) {
    const key = data.player === 1 ? 'score1' : 'score2';
    this.matchState[key] += data.action === 'add' ? 1 : -1;
    if (this.matchState[key] < 0) this.matchState[key] = 0;
    this.broadcastState();
  }

  @SubscribeMessage('toggle-view')
  handleToggleView() {
    this.viewMode = this.viewMode === 'MATCH' ? 'HISTORY' : 'MATCH';
    this.broadcastState();
    if (this.viewMode === 'HISTORY') this.sendHistory();
  }

  // --- HELPERS ---

  private startInterval() {
    this.stopTimer();
    this.isRunning = true;
    this.isPaused = false;
    this.broadcastState();
    this.interval = setInterval(() => {
      if (this.timer > 0) {
        this.timer--;
      } else {
        this.stopTimer();
        this.server.emit('timer-finished');
      }
      this.broadcastState();
    }, 1000);
  }

  private stopTimer() {
    this.isRunning = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private broadcastState() {
    // Envia TUDO, inclusive as Filas (Queues) para o Admin saber quem está esperando
    this.server.emit('update-display', {
      time: this.timer,
      ...this.matchState,
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      viewMode: this.viewMode,
      queues: this.queues, // <--- IMPORTANTE
    });
  }

  private async sendHistory() {
    const matches = await this.matchRepo.find({ order: { data: 'ASC' } });
    this.server.emit('update-history', matches);
  }

  // Remove nomes da fila quando a luta começa
  private removeFromQueue(fase: string, n1: string, n2: string) {
    // Se estou começando uma Semi, removo da fila 'semi'
    if (fase === 'semi') {
      this.queues.semi = this.queues.semi.filter((n) => n !== n1 && n !== n2);
    }
    // Se estou começando Final, removo da fila 'final'
    if (fase === 'final') {
      this.queues.final = this.queues.final.filter((n) => n !== n1 && n !== n2);
    }
  }
}
