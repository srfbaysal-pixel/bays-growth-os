export class AppError extends Error {
  constructor(public statusCode: number, message: string, public code = 'app_error', public details?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, d?: unknown) => new AppError(400, m, 'bad_request', d);
export const unauthorized = (m = 'Oturum gerekli') => new AppError(401, m, 'unauthorized');
export const forbidden = (m = 'Yetki yok') => new AppError(403, m, 'forbidden');
export const notFound = (m = 'Bulunamadı') => new AppError(404, m, 'not_found');
export const conflict = (m: string) => new AppError(409, m, 'conflict');
export const blocked = (m: string, d?: unknown) => new AppError(422, m, 'blocked', d);
