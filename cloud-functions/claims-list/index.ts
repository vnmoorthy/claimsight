/**
 * Claims list alias — EdgeOne Makers Node Function
 * ================================================
 *
 * File path cloud-functions/claims-list/index.ts maps to **GET /claims-list**.
 *
 * Identical to GET /claims (cloud-functions/claims/index.ts). It exists because the agent route
 * agents/claims/index.ts also owns `/claims` (POST): if a Makers deployment routes `/claims` to
 * the agent for every method, the Refund Desk can read the list from this path instead.
 */

export { onRequestGet } from '../claims/index';
