import { IsOptional, IsString } from 'class-validator';

export class ClientCredentialsDto {
  @IsString()
  grant_type: string;

  @IsString()
  client_id: string;

  @IsString()
  client_secret: string;

  @IsOptional()
  @IsString()
  scope?: string;
}