/**
 * Backward-compatible service aliases for older page modules.
 * New code should use friend-service.js because adding a contact now creates
 * a request rather than unilaterally establishing a relationship.
 */
import {
  getFriends,
  sendFriendRequest,
  removeFriend,
} from './friend-service.js';

export const getContacts = getFriends;
export const addContact = sendFriendRequest;
export const removeContact = removeFriend;

export default { getContacts, addContact, removeContact };
