import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

@Entity()
export class Match {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  nome1: string;

  @Column()
  nome2: string;

  @Column()
  score1: number;

  @Column()
  score2: number;

  @Column({ default: 'eliminatoria' }) // Novo campo
  fase: string; // ex: 'quartas', 'semi', 'final', 'terceiro'

  @CreateDateColumn()
  data: Date;
}
