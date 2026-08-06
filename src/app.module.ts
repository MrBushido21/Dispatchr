import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { typeOrmConfig } from './config/typeorm.config';
import { validate } from './config/env.validation';

@Module({
  imports: [
      ConfigModule.forRoot({ 
        isGlobal: true,
        envFilePath: process.env.NODE_ENV === 'test' ? '.env.test' : '.env',
        validate,
      }),
      TypeOrmModule.forRoot(typeOrmConfig),
  ],
})
export class AppModule {}
