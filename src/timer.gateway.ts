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

  // Estado do Jogo
  private timer: number = 60;
  private isRunning: boolean = false;
  private isPaused: boolean = false;
  private interval: NodeJS.Timeout | null = null;

  // 'MATCH' = Tela do Cronômetro | 'HISTORY' = Tela de Resultados
  private viewMode: 'MATCH' | 'HISTORY' = 'HISTORY';

  private matchState = {
    nome1: '',
    nome2: '',
    score1: 0,
    score2: 0,
    round: 1,
    fase: 'eliminatoria', // Padrão
  };

  // Quando alguém conecta, mandamos o histórico atualizado se estiver no modo histórico
  handleConnection(client: any) {
    this.broadcastState();
    if (this.viewMode === 'HISTORY') {
      this.sendHistory();
    }
  }

  @SubscribeMessage('start-match')
  handleStartMatch(
    @MessageBody() data: { nome1: string; nome2: string; fase: string },
  ) {
    console.log('Iniciando luta com fase:', data.fase); // <--- Adicione este log para debug

    this.matchState = {
      nome1: data.nome1,
      nome2: data.nome2,
      score1: 0,
      score2: 0,
      round: 1,
      fase: data.fase || 'eliminatoria', // <--- ISSO É ESSENCIAL
    };

    this.timer = 60;
    this.viewMode = 'MATCH';
    this.startInterval();
    this.broadcastState();
  }

  // Finalizar a luta e salvar no BD
  @SubscribeMessage('end-match')
  async handleEndMatch() {
    this.stopTimer();

    // Criação do objeto para salvar
    const match = this.matchRepo.create({
      nome1: this.matchState.nome1,
      nome2: this.matchState.nome2,
      score1: this.matchState.score1,
      score2: this.matchState.score2,
      fase: this.matchState.fase, // <--- TEM QUE ESTAR AQUI
    });

    console.log('Salvando no banco:', match); // <--- Adicione este log

    await this.matchRepo.save(match);

    this.viewMode = 'HISTORY';
    this.broadcastState();
    this.sendHistory();
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

  @SubscribeMessage('next-round')
  handleNextRound() {
    if (this.matchState.round < 3) this.matchState.round++;
    this.timer = 60;
    this.stopTimer();
    this.isPaused = true;
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
    // Inverte o modo atual
    this.viewMode = this.viewMode === 'MATCH' ? 'HISTORY' : 'MATCH';

    this.broadcastState();

    // Se mudou para histórico, precisa enviar os dados do banco
    if (this.viewMode === 'HISTORY') {
      this.sendHistory();
    }
  }

  // --- Helpers ---

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
    this.server.emit('update-display', {
      time: this.timer,
      ...this.matchState,
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      viewMode: this.viewMode, // Frontend precisa saber qual tela mostrar
    });
  }

  // Busca do banco e manda pro frontend
  private async sendHistory() {
    const matches = await this.matchRepo.find({ order: { data: 'ASC' } }); // Ordem de criação
    this.server.emit('update-history', matches);
  }
}
