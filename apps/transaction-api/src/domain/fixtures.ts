import type { AuthorizationRequest } from './authorization-request.js';

/** The request body from SPEC §6.1, used across tests. */
export function validRequest(): AuthorizationRequest {
  return {
    accountId: 'acc_000123',
    card: { pan: '4111111111111111', expiryMonth: 12, expiryYear: 2029, cvv: '123' },
    amount: { value: '1250.90', currency: 'BRL' },
    merchant: {
      id: 'mer_771',
      name: 'Loja Exemplo',
      mcc: '5732',
      country: 'BR',
      city: 'São Paulo',
    },
    channel: 'ECOMMERCE',
    entryMode: 'CARD_NOT_PRESENT',
    device: { ip: '203.0.113.10', deviceId: 'd-123' },
    geo: { lat: -23.55, lon: -46.63 },
  };
}
