import { plainToInstance, Type } from 'class-transformer';
import {
  IsEnum, IsInt, IsString, IsNotEmpty, MinLength, Min, Max, validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvConfig {
  @IsEnum(NodeEnv)
  NODE_ENV!: NodeEnv;

  @Type(() => Number)          // "3000" → 3000
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT!: number;

  
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  POSTGRES_PORT!: number;

  @IsString()
  @IsNotEmpty()                
  POSTGRES_HOST!: string;

  @IsString()
  @IsNotEmpty()                
  POSTGRES_DB!: string;

  @IsString()
  @IsNotEmpty()                
  POSTGRES_USER!: string;

  @IsString()
  @IsNotEmpty()                
  POSTGRES_PASSWORD!: string;

  @IsString()
  @IsNotEmpty()                
  REDIS_URL!: string;

  @IsString()
  @IsNotEmpty()                
  S3_ENDPOINT!: string;

  @IsString()
  @IsNotEmpty()                
  S3_REGION!: string;

  @IsString()
  @IsNotEmpty()                
  S3_ACCESS_KEY!: string;

  @IsString()
  @IsNotEmpty()                
  S3_SECRET_KEY!: string;

  @IsString()
  @IsNotEmpty()                
  S3_BUCKET!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(32)
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_TTL!: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_TTL!: string;
}

export function validate(raw: Record<string, unknown>): EnvConfig {
  const config = plainToInstance(EnvConfig, raw);

  const errors = validateSync(config, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((e) => ` - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Некорректный .env:\n${details}`);
  }

  return config;
}