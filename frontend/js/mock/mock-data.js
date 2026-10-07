/**
 * APERTURE - Mock Data Source
 * Isolated mock data so the mock layer can be removed without rewriting UI code.
 */
import { uuid } from '../utils.js';

const now = () => new Date().toISOString();
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

export const mockCurrentUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'you@aperture.app',
  displayName: 'Alex Morgan',
  username: 'alexmorgan',
  about: 'Always learning, always building.',
  avatarUrl: '',
  presence: 'online',
  lastSeen: now(),
};



export const mockGroupParticipants = [
  {
    id: mockCurrentUser.id,
    displayName: mockCurrentUser.displayName,
    username: mockCurrentUser.username,
    avatarUrl: mockCurrentUser.avatarUrl,
  },
  {
    id: '00000000-0000-0000-0000-000000000002',
    displayName: 'Shivratn Kumar',
    username: 'shivratn',
    avatarUrl: '',
  },
  {
    id: '00000000-0000-0000-0000-000000000003',
    displayName: 'Priya Sharma',
    username: 'priyasharma',
    avatarUrl: '',
  },
  {
    id: '00000000-0000-0000-0000-000000000004',
    displayName: 'Daniel Cohen',
    username: 'danielcohen',
    avatarUrl: '',
  },
];

export const mockConversations = [
  {
    id: 'conv-group-001',
    type: 'group',
    name: 'Aperture Project Team',
    participantId: null,
    participantName: 'Aperture Project Team',
    participantAvatar: '',
    participants: mockGroupParticipants,
    lastMessage: {
      id: 'msg-group-0009',
      conversationId: 'conv-group-001',
      senderId: '00000000-0000-0000-0000-000000000002',
      content: 'https://github.com/aperture/project',
      createdAt: '2026-10-05T16:00:00.000Z',
      status: 'read',
    },
    unreadCount: 0,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-05T16:00:00.000Z',
  },
  {
    id: 'conv-0001',
    type: 'direct',
    participantId: '00000000-0000-0000-0000-000000000002',
    participantName: 'Shivratn Kumar',
    participantAvatar: '',
    lastMessage: {
      id: 'msg-0010',
      content: "I'm coming in five minutes.",
      senderId: '00000000-0000-0000-0000-000000000001',
      createdAt: minsAgo(2),
      status: 'delivered',
    },
    unreadCount: 0,
    createdAt: minsAgo(5000),
    updatedAt: minsAgo(2),
  },
  {
    id: 'conv-0002',
    type: 'direct',
    participantId: '00000000-0000-0000-0000-000000000003',
    participantName: 'Priya Sharma',
    participantAvatar: '',
    lastMessage: {
      id: 'msg-0020',
      content: 'Did you see the photos I sent?',
      senderId: '00000000-0000-0000-0000-000000000003',
      createdAt: minsAgo(15),
      status: 'read',
    },
    unreadCount: 2,
    createdAt: minsAgo(4000),
    updatedAt: minsAgo(15),
  },
  {
    id: 'conv-0003',
    type: 'direct',
    participantId: '00000000-0000-0000-0000-000000000004',
    participantName: 'Daniel Cohen',
    participantAvatar: '',
    lastMessage: {
      id: 'msg-0030',
      content: 'New album drops next week!',
      senderId: '00000000-0000-0000-0000-000000000004',
      createdAt: minsAgo(55),
      status: 'read',
    },
    unreadCount: 1,
    createdAt: minsAgo(3000),
    updatedAt: minsAgo(55),
  },
  {
    id: 'conv-0004',
    type: 'direct',
    participantId: '00000000-0000-0000-0000-000000000005',
    participantName: 'Mei Tanaka',
    participantAvatar: '',
    lastMessage: {
      id: 'msg-0040',
      content: 'Trail run on Saturday?',
      senderId: '00000000-0000-0000-0000-000000000001',
      createdAt: minsAgo(180),
      status: 'read',
    },
    unreadCount: 0,
    createdAt: minsAgo(2000),
    updatedAt: minsAgo(180),
  },
];

export const mockMessages = {
  'conv-group-001': [
    {
      id: 'msg-group-0001',
      conversationId: 'conv-group-001',
      senderId: '00000000-0000-0000-0000-000000000002',
      content: 'Hey everyone, have we finalized the project design?',
      createdAt: '2026-10-03T09:30:00.000Z',
      status: 'read',
      type: 'text',
    },
    {
      id: 'msg-group-0002',
      conversationId: 'conv-group-001',
      senderId: '00000000-0000-0000-0000-000000000003',
      content: 'Almost. I am making a few changes to the UI.',
      createdAt: '2026-10-03T10:15:00.000Z',
      status: 'read',
      type: 'text',
    },
    {
      id: 'msg-group-0003',
      conversationId: 'conv-group-001',
      senderId: '00000000-0000-0000-0000-000000000001',
      content: 'Great. Please share the updated version once it is ready.',
      createdAt: '2026-10-03T11:00:00.000Z',
      status: 'read',
      type: 'text',
    },
    {
      id: 'msg-group-0004',
      conversationId: 'conv-group-001',
      senderId: '00000000-0000-0000-0000-000000000004',
      content: 'I have some ideas for improving the dashboard.',
      createdAt: '2026-10-04T09:45:00.000Z',
      status: 'read',
      type: 'text',
    },
    {
      id: 'msg-group-0005',
      conversationId: 'conv-group-001',
      senderId: '00000000-0000-0000-0000-000000000002',
      content: 'We should discuss those ideas in the next meeting.',
      createdAt: '2026-10-04T10:30:00.000Z',
      status: 'read',
      type: 'text',
    },
    {
      id: 'msg-group-0006',
      conversationId: 'conv-group-001',
      senderId: '00000000-0000-0000-0000-000000000003',
      content: 'Here is the UI preview.',
      createdAt: '2026-10-05T12:00:00.000Z',
      status: 'read',
      type: 'image',
      fileName: 'ui-preview.png',
      fileUrl: '#',
    },
    {
      id: 'msg-group-0007',
      conversationId: 'conv-group-001',
      senderId: '00000000-0000-0000-0000-000000000001',
      content: 'Looks good. I will review it today.',
      createdAt: '2026-10-05T13:15:00.000Z',
      status: 'read',
      type: 'text',
    },
    {
      id: 'msg-group-0008',
      conversationId: 'conv-group-001',
      senderId: '00000000-0000-0000-0000-000000000004',
      content: 'I have uploaded the latest project files.',
      createdAt: '2026-10-05T15:30:00.000Z',
      status: 'read',
      type: 'file',
      fileName: 'project-files.zip',
      fileUrl: '#',
    },
    {
      id: 'msg-group-0009',
      conversationId: 'conv-group-001',
      senderId: '00000000-0000-0000-0000-000000000002',
      content: 'https://github.com/aperture/project',
      createdAt: '2026-10-05T16:00:00.000Z',
      status: 'read',
      type: 'link',
      url: 'https://github.com/aperture/project',
    },
  ],
  'conv-0001': [
    { id: 'msg-0001', conversationId: 'conv-0001', senderId: '00000000-0000-0000-0000-000000000002', content: 'Hey, are you on your way?', createdAt: minsAgo(30), status: 'read' },
    { id: 'msg-0002', conversationId: 'conv-0001', senderId: '00000000-0000-0000-0000-000000000001', content: 'Yes, leaving now.', createdAt: minsAgo(28), status: 'read' },
    { id: 'msg-0003', conversationId: 'conv-0001', senderId: '00000000-0000-0000-0000-000000000002', content: 'Great, see you soon!', createdAt: minsAgo(25), status: 'read' },
    { id: 'msg-0004', conversationId: 'conv-0001', senderId: '00000000-0000-0000-0000-000000000001', content: "I'm coming in five minutes.", createdAt: minsAgo(2), status: 'delivered' },
  ],
  'conv-0002': [
    { id: 'msg-0011', conversationId: 'conv-0002', senderId: '00000000-0000-0000-0000-000000000003', content: 'Hey! How was your weekend?', createdAt: minsAgo(40), status: 'read' },
    { id: 'msg-0012', conversationId: 'conv-0002', senderId: '00000000-0000-0000-0000-000000000001', content: 'Really good, went hiking.', createdAt: minsAgo(38), status: 'read' },
    { id: 'msg-0013', conversationId: 'conv-0002', senderId: '00000000-0000-0000-0000-000000000003', content: 'Nice! I took some photos.', createdAt: minsAgo(20), status: 'read' },
    { id: 'msg-0014', conversationId: 'conv-0002', senderId: '00000000-0000-0000-0000-000000000003', content: 'Did you see the photos I sent?', createdAt: minsAgo(15), status: 'read' },
  ],
  'conv-0003': [
    { id: 'msg-0031', conversationId: 'conv-0003', senderId: '00000000-0000-0000-0000-000000000004', content: 'New album drops next week!', createdAt: minsAgo(55), status: 'read' },
  ],
  'conv-0004': [
    { id: 'msg-0041', conversationId: 'conv-0004', senderId: '00000000-0000-0000-0000-000000000001', content: 'Trail run on Saturday?', createdAt: minsAgo(180), status: 'read' },
  ],
};

export const mockUsers = [
  {
    id: '00000000-0000-0000-0000-000000000002',
    displayName: 'Shivratn Kumar',
    username: 'shivratn',
    email: 'shivratn@example.com',
    about: 'Designer & coffee enthusiast.',
    avatarUrl: '',
    presence: 'online',
    lastSeen: now(),
  },
  {
    id: '00000000-0000-0000-0000-000000000003',
    displayName: 'Priya Sharma',
    username: 'priyasharma',
    email: 'priya@example.com',
    about: 'Photographer. Nature lover.',
    avatarUrl: '',
    presence: 'offline',
    lastSeen: minsAgo(12),
  },
  {
    id: '00000000-0000-0000-0000-000000000004',
    displayName: 'Daniel Cohen',
    username: 'danielcohen',
    email: 'daniel@example.com',
    about: 'Musician. Vinyl collector.',
    avatarUrl: '',
    presence: 'online',
    lastSeen: now(),
  },
  {
    id: '00000000-0000-0000-0000-000000000005',
    displayName: 'Mei Tanaka',
    username: 'meitanaka',
    email: 'mei@example.com',
    about: 'Engineer. Trail runner.',
    avatarUrl: '',
    presence: 'offline',
    lastSeen: minsAgo(180),
  },
  {
    id: '00000000-0000-0000-0000-000000000006',
    displayName: 'Shivraj Patel',
    username: 'shivraj',
    email: 'shivraj@example.com',
    about: 'Student. Gamer.',
    avatarUrl: '',
    presence: 'offline',
    lastSeen: minsAgo(60),
  },
  {
    id: '00000000-0000-0000-0000-000000000007',
    displayName: 'Shriraj Nair',
    username: 'shriraj',
    email: 'shriraj@example.com',
    about: 'Chef. Traveler.',
    avatarUrl: '',
    presence: 'offline',
    lastSeen: minsAgo(240),
  },
];

export const mockContacts = [
  { userId: '00000000-0000-0000-0000-000000000002', addedAt: minsAgo(5000) },
  { userId: '00000000-0000-0000-0000-000000000003', addedAt: minsAgo(4000) },
  { userId: '00000000-0000-0000-0000-000000000004', addedAt: minsAgo(3000) },
  { userId: '00000000-0000-0000-0000-000000000005', addedAt: minsAgo(2000) },
];

export const mockCalls = [
  { id: 'call-0001', callerId: '00000000-0000-0000-0000-000000000002', calleeId: '00000000-0000-0000-0000-000000000001', displayName: 'Shivratn Kumar', avatarUrl: '', direction: 'incoming', status: 'completed', startedAt: minsAgo(120), endedAt: minsAgo(117), duration: 180 },
  { id: 'call-0002', callerId: '00000000-0000-0000-0000-000000000001', calleeId: '00000000-0000-0000-0000-000000000003', displayName: 'Priya Sharma', avatarUrl: '', direction: 'outgoing', status: 'missed', startedAt: minsAgo(90), endedAt: null, duration: 0 },
  { id: 'call-0003', callerId: '00000000-0000-0000-0000-000000000004', calleeId: '00000000-0000-0000-0000-000000000001', displayName: 'Daniel Cohen', avatarUrl: '', direction: 'incoming', status: 'rejected', startedAt: minsAgo(50), endedAt: null, duration: 0 },
  { id: 'call-0004', callerId: '00000000-0000-0000-0000-000000000001', calleeId: '00000000-0000-0000-0000-000000000005', displayName: 'Mei Tanaka', avatarUrl: '', direction: 'outgoing', status: 'completed', startedAt: minsAgo(10), endedAt: minsAgo(7), duration: 180 },
];

export const mockAdminUsers = [
  { id: '00000000-0000-0000-0000-000000000001', displayName: 'Alex Morgan', email: 'you@aperture.app', role: 'admin', status: 'active', createdAt: minsAgo(10000) },
  { id: '00000000-0000-0000-0000-000000000002', displayName: 'Shivratn Kumar', email: 'shivratn@example.com', role: 'user', status: 'active', createdAt: minsAgo(9000) },
  { id: '00000000-0000-0000-0000-000000000003', displayName: 'Priya Sharma', email: 'priya@example.com', role: 'user', status: 'active', createdAt: minsAgo(8000) },
  { id: '00000000-0000-0000-0000-000000000004', displayName: 'Daniel Cohen', email: 'daniel@example.com', role: 'user', status: 'suspended', createdAt: minsAgo(7000) },
  { id: '00000000-0000-0000-0000-000000000005', displayName: 'Mei Tanaka', email: 'mei@example.com', role: 'user', status: 'active', createdAt: minsAgo(6000) },
];

export const mockReports = [
  { id: 'report-0001', reporterId: '00000000-0000-0000-0000-000000000003', reportedId: '00000000-0000-0000-0000-000000000004', reason: 'Spam', status: 'pending', createdAt: minsAgo(200) },
  { id: 'report-0002', reporterId: '00000000-0000-0000-0000-000000000002', reportedId: '00000000-0000-0000-0000-000000000005', reason: 'Harassment', status: 'reviewing', createdAt: minsAgo(100) },
];

export const mockSystemStatus = {
  api: 'operational',
  websocket: 'operational',
  webrtc: 'operational',
  database: 'operational',
  storage: 'operational',
  auth: 'operational',
  lastIncident: minsAgo(5000),
};

/** Generate a mock assist command response. */
export function mockAssistResponse(transcript) {
  const lower = (transcript || '').toLowerCase();
  if (lower.includes('call')) {
    return {
      commandId: uuid(),
      state: 'CONFIRMING',
      intent: 'CALL_CONTACT',
      transcript,
      recipient: { id: '00000000-0000-0000-0000-000000000002', displayName: 'Shivratn' },
      message: null,
      confidence: 0.88,
      risk: 'HIGH',
      confirmationRequired: true,
      spokenResponse: "I'll call Shivratn.",
    };
  }
  // Default: send message
  return {
    commandId: uuid(),
    state: 'CONFIRMING',
    intent: 'SEND_MESSAGE',
    transcript,
    recipient: { id: '00000000-0000-0000-0000-000000000002', displayName: 'Shivratn' },
    message: "I'm coming in five minutes.",
    confidence: 0.94,
    risk: 'HIGH',
    confirmationRequired: true,
    spokenResponse: "I'll message Shivratn: I'm coming in five minutes.",
  };
}
