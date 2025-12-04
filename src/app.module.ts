import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { TimerGateway } from './timer.gateway';
import { Match } from './match.entity';

@Module({
  imports: [
    // Configuração do SQLite
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: 'torneio.db', // O arquivo será criado na raiz
      entities: [Match],
      synchronize: true, // Cria as tabelas automaticamente (bom para dev)
    }),
    TypeOrmModule.forFeature([Match]), // Registra a entidade para uso
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'client'),
    }),
  ],
  providers: [TimerGateway],
})
export class AppModule {}
