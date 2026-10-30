import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ResilienceService } from '@nestjs/resilience';
import { firstValueFrom } from 'rxjs';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';

@Injectable()
export class ResilientHttpService {
  constructor(
    private readonly httpService: HttpService,
    private readonly resilienceService: ResilienceService,
  ) {}

  private policy() {
    return this.resilienceService.preset('http');
  }

  async request<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.policy().execute(async () => firstValueFrom(this.httpService.request<T>(config)));
  }

  async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.policy().execute(async () => firstValueFrom(this.httpService.get<T>(url, config)));
  }

  async post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.policy().execute(async () => firstValueFrom(this.httpService.post<T>(url, data, config)));
  }

  async put<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.policy().execute(async () => firstValueFrom(this.httpService.put<T>(url, data, config)));
  }

  async delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.policy().execute(async () => firstValueFrom(this.httpService.delete<T>(url, config)));
  }
}