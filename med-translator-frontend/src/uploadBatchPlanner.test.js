import { describe, expect, it } from 'vitest'
import {
  MAX_FILES_PER_UPLOAD_BATCH,
  planUploadBatches,
} from './uploadBatchPlanner.js'

function file(name, size, webkitRelativePath = '') {
  return { name, size, type: 'application/pdf', webkitRelativePath }
}

describe('planUploadBatches', () => {
  it('turns one selected root directory into separately queued book batches', () => {
    const plans = planUploadBatches([
      file('1.pdf', 10, 'File chờ dịch/Mandell/1.pdf'),
      file('2.pdf', 10, 'File chờ dịch/Mandell/2.pdf'),
      file('1.pdf', 10, 'File chờ dịch/Harrison/1.pdf'),
    ], { groupByDirectory: true })

    expect(plans).toHaveLength(2)
    expect(plans.map(plan => [plan.folderName, plan.files.length])).toEqual([
      ['Mandell', 2],
      ['Harrison', 1],
    ])
  })

  it('splits a large folder into bounded, resumable batches without changing its folder name', () => {
    const files = Array.from({ length: MAX_FILES_PER_UPLOAD_BATCH + 1 }, (_, index) => (
      file(`${index + 1}.pdf`, 10)
    ))
    const plans = planUploadBatches(files, { fallbackFolderName: 'Mandell' })

    expect(plans).toHaveLength(2)
    expect(plans.map(plan => plan.folderName)).toEqual(['Mandell', 'Mandell'])
    expect(plans.map(plan => plan.files.length)).toEqual([MAX_FILES_PER_UPLOAD_BATCH, 1])
    expect(plans.map(plan => plan.displayName)).toEqual(['Mandell · phần 1/2', 'Mandell · phần 2/2'])
  })
})
