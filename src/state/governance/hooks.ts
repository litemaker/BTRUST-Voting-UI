import { BTRUST, PRELOADED_PROPOSALS } from './../../constants/index'
import { TokenAmount } from '@uniswap/sdk'
import { isAddress } from 'ethers/lib/utils'
import { useGovernanceContract, useBTrustContract } from '../../hooks/useContract'
import { useSingleCallResult, useSingleContractMultipleData } from '../multicall/hooks'
import { useActiveWeb3React } from '../../hooks'
import { ethers, utils } from 'ethers'
import { calculateGasMargin } from '../../utils'
import { TransactionResponse } from '@ethersproject/providers'
import { useTransactionAdder } from '../transactions/hooks'
import { useState, useEffect, useCallback } from 'react'
//import encodeParameters from '../../utils/Ethereum'
//import { abi as GOV_ABI } from '@uniswap/governance/build/GovernorAlpha.json'
import GOVERNANCE from '../../abi/Governance.json'
const GOV_ABI = GOVERNANCE.abi

interface ProposalDetail {
  target: string
  functionSig: string
  callData: string
}

export interface ProposalData {
  id: string
  title: string
  description: string
  proposer: string
  status: string
  forCount: number
  againstCount: number
  startBlock: number
  endBlock: number
  details: ProposalDetail[]
}

export const enumerateProposalState = (state: number) => {
  const proposalStates = ['pending', 'active', 'canceled', 'defeated', 'succeeded', 'queued', 'expired', 'executed']
  return proposalStates[state]
}

// get count of all proposals made
export function useProposalCount(): number | undefined {
  const gov = useGovernanceContract()
  const res = useSingleCallResult(gov, 'proposalCount')
  if (res.result && !res.loading) {
    return parseInt(res.result[0])
  }
  return undefined
}

/**
 * Need proposal events to get description data emitted from
 * new proposal event.
 */
export function useDataFromEventLogs() {
  const { library } = useActiveWeb3React()
  const [formattedEvents, setFormattedEvents] = useState<any>()
  const govContract = useGovernanceContract()

  // create filter for these specific events
  const filter = { ...govContract?.filters?.['ProposalCreated'](), fromBlock: 0, toBlock: 'latest' }
  const eventParser = new ethers.utils.Interface(GOV_ABI)

  useEffect(() => {
    async function fetchData() {
      const pastEvents = await library?.getLogs(filter)
      // reverse events to get them from newest to odlest
      const formattedEventData = pastEvents
        ?.map(event => {
          const eventParsed = eventParser.parseLog(event).args
          return {
            description: eventParsed.description,
            details: eventParsed.targets.map((target: string, i: number) => {
              const signature = eventParsed.signatures[i]
              const [name, types] = signature.substr(0, signature.length - 1).split('(')
              const calldata = eventParsed.calldatas[i]
              const decoded = utils.defaultAbiCoder.decode(types.split(','), calldata)

              return {
                target,
                functionSig: name,
                callData: decoded.join(', ')
              }
            })
          }
        })
        .reverse()
      setFormattedEvents(formattedEventData)
    }
    if (!formattedEvents) {
      fetchData()
    }
  }, [eventParser, filter, library, formattedEvents])

  return formattedEvents
}

// get data for all past and active proposals
export function useAllProposalData() {
  const proposalCount = useProposalCount()
  const govContract = useGovernanceContract()

  const proposalIndexes = []
  for (let i = 1; i <= (proposalCount ?? 0); i++) {
    proposalIndexes.push([i])
  }

  // get metadata from past events
  const formattedEvents = useDataFromEventLogs()

  // get all proposal entities
  const allProposals = useSingleContractMultipleData(govContract, 'proposals', proposalIndexes)

  // get all proposal states
  const allProposalStates = useSingleContractMultipleData(govContract, 'state', proposalIndexes)

  if (formattedEvents && allProposals && allProposalStates) {
    allProposals.reverse()
    allProposalStates.reverse()

    return allProposals
      .filter((p, i) => {
        return Boolean(p.result) && Boolean(allProposalStates[i]?.result) && Boolean(formattedEvents[i])
      })
      .map((p, i) => {
        const description = PRELOADED_PROPOSALS.get(allProposals.length - i - 1) || formattedEvents[i].description
        const formattedProposal: ProposalData = {
          id: allProposals[i]?.result?.id.toString(),
          title: description?.split(/# |\n/g)[1] || 'Untitled',
          description: description || 'No description.',
          proposer: allProposals[i]?.result?.proposer,
          status: enumerateProposalState(allProposalStates[i]?.result?.[0]) ?? 'Undetermined',
          forCount: parseFloat(ethers.utils.formatUnits(allProposals[i]?.result?.forVotes.toString(), 18)),
          againstCount: parseFloat(ethers.utils.formatUnits(allProposals[i]?.result?.againstVotes.toString(), 18)),
          startBlock: parseInt(allProposals[i]?.result?.startBlock?.toString()),
          endBlock: parseInt(allProposals[i]?.result?.endBlock?.toString()),
          details: formattedEvents[i].details
        }
        return formattedProposal
      })
  } else {
    return []
  }
}

// get total number of proposals in each of the states
export function useProposalCountByState() {
  const proposalStates = ['pending', 'active', 'canceled', 'defeated', 'succeeded', 'queued', 'expired', 'executed']
  const result = [0, 0, 0, 0, 0, 0, 0, 0]
  const allProposals = useAllProposalData()
  allProposals.forEach(p => {
    const res = proposalStates.indexOf(p.status)
    if (res !== -1) {
      result[res]++
    }
  })
  return result
}

export function useProposalData(id: string): ProposalData | undefined {
  const allProposalData = useAllProposalData()
  return allProposalData?.find(p => p.id === id)
}

// get the users delegatee if it exists
export function useUserDelegatee(): string {
  const { account } = useActiveWeb3React()
  const bTrustContract = useBTrustContract()
  const { result } = useSingleCallResult(bTrustContract, 'delegates', [account ?? undefined])
  return result?.[0] ?? undefined
}

// gets the users current votes
export function useUserVotes(): TokenAmount | undefined {
  const { account, chainId } = useActiveWeb3React()
  const bTrustContract = useBTrustContract()

  // check for available votes
  const bTrust = chainId ? BTRUST[chainId] : undefined
  const votes = useSingleCallResult(bTrustContract, 'getCurrentVotes', [account ?? undefined])?.result?.[0]
  return votes && bTrust ? new TokenAmount(bTrust, votes) : undefined
}

// fetch available votes as of block (usually proposal start block)
export function useUserVotesAsOfBlock(block: number | undefined): TokenAmount | undefined {
  const { account, chainId } = useActiveWeb3React()
  const bTrustContract = useBTrustContract()

  // check for available votes
  const bTrust = chainId ? BTRUST[chainId] : undefined
  const votes = useSingleCallResult(bTrustContract, 'getPriorVotes', [account ?? undefined, block ?? undefined])
    ?.result?.[0]
  return votes && bTrust ? new TokenAmount(bTrust, votes) : undefined
}

export function useDelegateCallback(): (delegatee: string | undefined) => undefined | Promise<string> {
  const { account, chainId, library } = useActiveWeb3React()
  const addTransaction = useTransactionAdder()

  const bTrustContract = useBTrustContract()

  return useCallback(
    (delegatee: string | undefined) => {
      if (!library || !chainId || !account || !isAddress(delegatee ?? '')) return undefined
      const args = [delegatee]
      if (!bTrustContract) throw new Error('No BTRUST Contract!')
      return bTrustContract.estimateGas.delegate(...args, {}).then(estimatedGasLimit => {
        return bTrustContract
          .delegate(...args, { value: null, gasLimit: calculateGasMargin(estimatedGasLimit) })
          .then((response: TransactionResponse) => {
            addTransaction(response, {
              summary: `Delegated votes`
            })
            return response.hash
          })
      })
    },
    [account, addTransaction, chainId, library, bTrustContract]
  )
}

export function useVoteCallback(): {
  voteCallback: (proposalId: string | undefined, support: boolean) => undefined | Promise<string>
} {
  const { account } = useActiveWeb3React()

  const govContract = useGovernanceContract()
  const addTransaction = useTransactionAdder()

  const voteCallback = useCallback(
    (proposalId: string | undefined, support: boolean) => {
      if (!account || !govContract || !proposalId) return
      const args = [proposalId, support]
      return govContract.estimateGas.castVote(...args, {}).then(estimatedGasLimit => {
        return govContract
          .castVote(...args, { value: null, gasLimit: calculateGasMargin(estimatedGasLimit) })
          .then((response: TransactionResponse) => {
            addTransaction(response, {
              summary: `Voted ${support ? 'for ' : 'against'} proposal ${proposalId}`
            })
            return response.hash
          })
      })
    },
    [account, addTransaction, govContract]
  )
  return { voteCallback }
}
