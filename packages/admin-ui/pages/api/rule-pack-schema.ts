import type { NextApiRequest, NextApiResponse } from 'next';
import { rulePackJsonSchema } from '@agentworks/shared';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(rulePackJsonSchema);
}
