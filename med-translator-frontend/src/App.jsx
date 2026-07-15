import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import './App.css';
import api, { API_BASE_URL } from './api/client.js';
import { uploadBatchToCloud } from './cloudUploader.js';

const formatMegabytes = bytes => `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)} MB`;

const serverBatchToTask = batch => ({
  id: `server-${batch.batchId}`,
  batchId: batch.batchId,
  clientBatchId: batch.clientBatchId,
  folderName: batch.folderName,
  entries: [],
  totalFiles: batch.totalFiles,
  totalBytes: batch.totalBytes,
  uploadedBytes: batch.confirmedBytes,
  confirmedFiles: batch.confirmedFiles,
  percent: batch.totalBytes > 0 ? Math.round(batch.confirmedBytes * 100 / batch.totalBytes) : 0,
  canCloseClient: batch.canCloseClient,
  status: batch.canCloseClient ? 'safe' : 'error',
  progressMsg: batch.canCloseClient
    ? '✅ Batch đã an toàn trên Cloud; trạng thái được phục hồi từ MongoDB.'
    : '⚠️ Batch chưa upload đủ. Hãy chọn lại đúng các file còn thiếu để tiếp tục.',
});

const mergeServerBatches = (previous, batches) => {
  const byBatchId = new Map(previous.filter(task => task.batchId).map(task => [task.batchId, task]));
  for (const batch of batches) {
    const restored = serverBatchToTask(batch);
    const existing = byBatchId.get(batch.batchId);
    byBatchId.set(batch.batchId, existing ? {
      ...restored,
      ...existing,
      confirmedFiles: batch.confirmedFiles,
      uploadedBytes: batch.confirmedBytes,
      percent: batch.totalBytes > 0 ? Math.round(batch.confirmedBytes * 100 / batch.totalBytes) : existing.percent,
      canCloseClient: batch.canCloseClient,
      status: batch.canCloseClient ? 'safe' : existing.status,
      progressMsg: batch.canCloseClient ? restored.progressMsg : existing.progressMsg,
    } : restored);
  }
  const withoutBatchId = previous.filter(task => !task.batchId);
  return [...withoutBatchId, ...byBatchId.values()];
};

// Ưu tiên đọc từ biến môi trường của Vercel/Vite, nếu không có sẽ tự động dùng máy chủ mặc định
// -------------------------------------------------------------
// COMPONENT CON: JOB CARD (Quản lý hiển thị cho từng file)
// -------------------------------------------------------------
const JobCard = ({ job, onDelete }) => {
  const [isCopied, setIsCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  
  // State quản lý kết quả cục bộ
  const [localResult, setLocalResult] = useState(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  // Hàm Lazy Fetch nội dung
  const fetchResultOnDemand = async () => {
    if (localResult) return localResult; // Đã tải rồi thì dùng luôn trong cache
    setIsLoadingContent(true);
    try {
      const res = await api.get(`/jobs/${encodeURIComponent(job.jobId)}/result`, {
        timeout: 60_000,
      });
      setLocalResult(res.data.result);
      return res.data.result;
    } catch {
      alert('Lỗi tải nội dung từ Server!');
      return null;
    } finally {
      setIsLoadingContent(false);
    }
  };

  const handleCopy = async () => {
    const content = await fetchResultOnDemand();
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      alert('Không thể copy nội dung!');
    }
  };

  const handleTogglePreview = async () => {
    if (!showPreview) {
      await fetchResultOnDemand();
    }
    setShowPreview(!showPreview);
  };

  return (
    <div className={`job-card ${job.status}`}>
      <div className="job-header">
        <div className="job-info">
          <span className="job-name">📄 {job.originalName || job.fileName || 'Tài liệu'}</span>
          <span className={`status-badge ${job.status}`}>
            {job.status === 'uploading' && '☁️ Đang lên Cloud...'}
            {job.status === 'pending' && (job.nextRetryAt ? '🔄 Chờ thử lại...' : '⏳ Đang chờ...')}
            {job.status === 'processing' && `⚙️ Đang dịch${job.chunkCount ? ` ${job.completedChunks || 0}/${job.chunkCount}` : '...'}`}
            {job.status === 'completed' && '✅ Hoàn thành'}
            {job.status === 'failed' && '❌ Lỗi'}
            {job.status === 'cancelled' && '🛑 Đã hủy'}
          </span>
        </div>

        <div className="job-actions">
          {job.status === 'completed' && (
            <>
              <button className="preview-btn" onClick={handleTogglePreview} disabled={isLoadingContent}>
                {isLoadingContent ? '⏳ Đang tải...' : (showPreview ? 'Đóng xem trước' : '👁️ Xem trước')}
              </button>
              <button onClick={handleCopy} className={`copy-btn ${isCopied ? 'copied' : ''}`} disabled={isLoadingContent}>
                {isCopied ? '✅ Đã Copy' : '📋 Copy Markdown'}
              </button>
            </>
          )}
          
          {(['pending', 'processing', 'failed', 'completed', 'cancelled'].includes(job.status)) && (
            <button 
              onClick={() => onDelete(job.jobId, job.status)}
              className="delete-btn" 
              style={{ backgroundColor: '#dc3545', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', marginLeft: '8px', fontSize: '0.9em' }}
            >
              {['pending', 'processing'].includes(job.status) ? '🛑 Hủy' : '🗑️ Xóa'}
            </button>
          )}
        </div>
      </div>

      {job.status === 'failed' && (
        <div className="job-error">Chi tiết lỗi: {job.error}</div>
      )}

      {job.status === 'pending' && job.error && (
        <div className="job-retry">
          {job.error}
          {job.nextRetryAt && ` Thử lại lúc ${new Date(job.nextRetryAt).toLocaleTimeString('vi-VN')}.`}
        </div>
      )}

      {job.status === 'completed' && showPreview && localResult && (
        <div className="markdown-preview mt-15">
          <ReactMarkdown>{localResult}</ReactMarkdown>
        </div>
      )}
    </div>
  );
};

// -------------------------------------------------------------
// COMPONENT CHÍNH: APP (Quản lý Queue, API, và SSE)
// -------------------------------------------------------------
function App() {
  const [selectedFiles, setSelectedFiles] = useState(null);
  const [folderName, setFolderName] = useState(''); 
  
  const [localQueue, setLocalQueue] = useState([]);
  const [activeUploadTaskId, setActiveUploadTaskId] = useState(null);
  
  const [jobs, setJobs] = useState([]); 
  const [sysStatus, setSysStatus] = useState({ isHibernating: false, stats: null });
  const [collapsedFolders, setCollapsedFolders] = useState({});
  const [sseConnected, setSseConnected] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);

  const toggleFolder = (folderName) => { 
    setCollapsedFolders(prev => ({ ...prev, [folderName]: !prev[folderName] })); 
  };

  // 1. Phục hồi trạng thái khi F5 (Bao gồm cả trạng thái Hệ thống và Jobs)
  useEffect(() => {
    const fetchInitialData = async () => {
      try {
        // Lấy trạng thái hệ thống
        const statusRes = await api.get('/status');
        setSysStatus(statusRes.data);

      // Lấy danh sách Jobs
        const jobsRes = await api.get('/jobs');
        
        // Cầu chì bảo vệ: Chặn trường hợp Render trả về trang HTML 502 thay vì JSON
        const jobItems = Array.isArray(jobsRes.data) ? jobsRes.data : jobsRes.data?.items;
        if (Array.isArray(jobItems)) {
            const formattedJobs = jobItems.map(j => ({ ...j, logs: [], result: null }));
            setJobs(formattedJobs);
            setNextCursor(Array.isArray(jobsRes.data) ? null : jobsRes.data.nextCursor);
        } else {
            throw new Error("Cloud Server trả về dữ liệu không hợp lệ.");
        }

        try {
          const batchesRes = await api.get('/upload-batches', { params: { limit: 20 } });
          const batches = Array.isArray(batchesRes.data?.items) ? batchesRes.data.items : [];
          setLocalQueue(previous => mergeServerBatches(previous, batches));
        } catch (batchError) {
          console.error('Không thể phục hồi upload batch:', batchError);
        }
      } catch (error) {
        console.error("Lỗi khởi tạo dữ liệu:", error);
        alert("⚠️ Không thể tải danh sách tài liệu từ Cloud. Máy chủ đang khởi động hoặc quá tải do phục hồi dữ liệu. Vui lòng nhấn F5 (Tải lại trang) sau 30 giây.");
      }
    };
    fetchInitialData();
  }, []);

  useEffect(() => {
    const hasUnsafeUpload = localQueue.some(task => !task.canCloseClient && task.status !== 'hidden');
    if (!hasUnsafeUpload) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', warnBeforeUnload);
    };
  }, [localQueue]);

  // 3. Lắng nghe SSE thời gian thực từ Backend
  useEffect(() => {
    const eventSource = new EventSource(`${API_BASE_URL}/stream`);

    const resync = async () => {
      try {
        const [statusRes, jobsRes, batchesRes] = await Promise.all([
          api.get('/status', { timeout: 30_000 }),
          api.get('/jobs', { timeout: 30_000 }),
          api.get('/upload-batches', { params: { limit: 20 }, timeout: 30_000 }),
        ]);
        setSysStatus(statusRes.data);
        const jobItems = Array.isArray(jobsRes.data) ? jobsRes.data : jobsRes.data?.items;
        if (Array.isArray(jobItems)) {
          setJobs(jobItems.map(job => ({ ...job, logs: [], result: null })));
          setNextCursor(Array.isArray(jobsRes.data) ? null : jobsRes.data.nextCursor);
        }
        const batches = Array.isArray(batchesRes.data?.items) ? batchesRes.data.items : [];
        setLocalQueue(previous => mergeServerBatches(previous, batches));
      } catch (error) {
        console.error('Không thể đồng bộ lại SSE:', error);
      }
    };

    eventSource.onopen = () => {
      setSseConnected(true);
      void resync();
    };

    eventSource.onerror = () => {
      setSseConnected(false);
    };

    eventSource.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (error) {
        console.error('SSE trả về dữ liệu không hợp lệ:', error);
        return;
      }

      // Lắng nghe sự kiện hệ thống ngủ đông / thức dậy
      if (data.type === 'systemStatus') {
        setSysStatus(previous => ({ ...previous, ...data.data }));
      }
      else if (data.type === 'status') {
        setJobs(prevJobs => prevJobs.map(job => 
          job.jobId === data.jobId ? { ...job, ...data } : job
        ));
      }
      else if (data.type === 'batchStatus') {
        setLocalQueue(previous => previous.map(task => {
          if (task.batchId !== data.data?.batchId) return task;
          const confirmedBytes = data.data.confirmedBytes ?? task.uploadedBytes;
          const totalBytes = data.data.totalBytes ?? task.totalBytes;
          const canCloseClient = Boolean(data.data.canCloseClient);
          return {
            ...task,
            ...data.data,
            uploadedBytes: confirmedBytes,
            percent: totalBytes > 0 ? Math.round(confirmedBytes * 100 / totalBytes) : task.percent,
            canCloseClient,
            status: canCloseClient ? 'safe' : task.status,
            progressMsg: canCloseClient
              ? '✅ Đã xác nhận an toàn trên Cloud — có thể tắt máy.'
              : `Cloud đã xác nhận ${data.data.confirmedFiles || 0}/${data.data.totalFiles || task.totalFiles} file.`,
          };
        }));
      }
      else if (data.type === 'sourceCleanup') {
        setJobs(previous => previous.map(job => job.jobId === data.data?.jobId
          ? { ...job, sourceCleanupStatus: data.data.status }
          : job));
      }
    };

    return () => eventSource.close();
  }, []); 

  const updateCloudTask = (taskId, changes) => {
    setLocalQueue(previous => previous.map(task => task.id === taskId
      ? { ...task, ...(typeof changes === 'function' ? changes(task) : changes) }
      : task));
  };

  const startCloudUpload = async (task) => {
    if (activeUploadTaskId) return;
    setActiveUploadTaskId(task.id);
    updateCloudTask(task.id, { status: 'preparing', progressMsg: 'Đang chuẩn bị URL upload an toàn...' });
    try {
      const result = await uploadBatchToCloud({
        clientBatchId: task.clientBatchId,
        folderName: task.folderName,
        entries: task.entries,
        concurrency: 4,
        onPrepared: prepared => {
          updateCloudTask(task.id, { batchId: prepared.batchId, status: 'uploading' });
          const preparedJobs = prepared.items.map(item => ({
            jobId: item.jobId,
            originalName: item.name,
            folderName: task.folderName,
            status: item.status,
            logs: [],
            result: null,
          }));
          setJobs(previous => {
            const known = new Set(previous.map(job => job.jobId));
            return [...preparedJobs.filter(job => !known.has(job.jobId)), ...previous];
          });
        },
        onProgress: progress => updateCloudTask(task.id, {
          ...progress,
          progressMsg: progress.canCloseClient
            ? 'Đã lưu an toàn trên Cloud — có thể tắt máy.'
            : `Đang upload lên R2: ${progress.percent}% · xác nhận ${progress.confirmedFiles}/${progress.totalFiles} file`,
        }),
        onItemState: (clientUploadId, state) => updateCloudTask(task.id, current => ({
          itemStates: { ...current.itemStates, [clientUploadId]: state },
        })),
      });
      updateCloudTask(task.id, {
        status: 'safe',
        canCloseClient: true,
        files: [],
        confirmedFiles: result.confirmedFiles,
        confirmedBytes: result.confirmedBytes,
        progressMsg: '✅ Đã lưu trên Cloud — có thể đóng tab hoặc tắt máy. Render sẽ tiếp tục dịch.',
      });
    } catch (error) {
      updateCloudTask(task.id, {
        status: 'error',
        canCloseClient: false,
        error: error.message,
        failedItems: error.details?.failedItems || [],
        batchId: error.details?.batchId || task.batchId,
        progressMsg: `❌ ${error.message} Hãy bấm “Thử lại”.`,
      });
    } finally {
      setActiveUploadTaskId(null);
    }
  };

  const handleAddToQueue = () => {
    if (!selectedFiles || selectedFiles.length === 0 || activeUploadTaskId) return;
    const files = Array.from(selectedFiles);
    if (files.length > 500) {
      alert('Mỗi batch chỉ được tối đa 500 file PDF.');
      return;
    }
    const invalidFile = files.find(file => !file.name.toLowerCase().endsWith('.pdf')
      || (file.type && file.type !== 'application/pdf'));
    if (invalidFile) {
      alert(`${invalidFile.name} không phải file PDF hợp lệ.`);
      return;
    }
    const task = {
      id: crypto.randomUUID(),
      clientBatchId: crypto.randomUUID(),
      folderName: folderName.trim() || 'Mặc định',
      entries: files.map(file => ({ file, clientUploadId: crypto.randomUUID() })),
      totalFiles: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      uploadedBytes: 0,
      confirmedFiles: 0,
      percent: 0,
      canCloseClient: false,
      itemStates: {},
      status: 'preparing',
      progressMsg: 'Đang chuẩn bị upload lên Cloud...',
    };
    setLocalQueue(previous => [...previous, task]);
    document.getElementById('fileInput').value = '';
    setSelectedFiles(null);
    setFolderName('');
    void startCloudUpload(task);
  };

  const handleRemoveFromQueue = (taskId) => {
    setLocalQueue(previous => previous.filter(task => task.id !== taskId || task.id === activeUploadTaskId));
  };

  const handleRetryLocalTask = (taskId) => {
    const task = localQueue.find(candidate => candidate.id === taskId);
    if (task && !activeUploadTaskId) void startCloudUpload(task);
  };

  const handleAbandonFailedItems = async (task) => {
    const jobIds = (task.failedItems || []).map(item => item.jobId).filter(Boolean);
    if (!task.batchId || jobIds.length === 0) return;
    if (!window.confirm(`Bỏ ${jobIds.length} file lỗi khỏi batch này? Các file đó sẽ không được dịch.`)) return;
    try {
      const response = await api.post(
        `/upload-batches/${encodeURIComponent(task.batchId)}/abandon`,
        { items: jobIds.map(jobId => ({ jobId })) },
      );
      updateCloudTask(task.id, {
        ...response.data,
        status: response.data.canCloseClient ? 'safe' : 'error',
        canCloseClient: response.data.canCloseClient,
        progressMsg: response.data.canCloseClient
          ? '✅ Các file còn lại đã an toàn trên Cloud; file lỗi đã được bỏ theo yêu cầu.'
          : 'Đã bỏ file lỗi nhưng batch vẫn còn file chưa xác nhận.',
      });
    } catch (error) {
      updateCloudTask(task.id, { progressMsg: `❌ Không thể bỏ file lỗi: ${error.response?.data?.error || error.message}` });
    }
  };

  const handleLoadMoreJobs = async () => {
    if (!nextCursor) return;
    try {
      const response = await api.get('/jobs', {
        params: { cursor: nextCursor, limit: 100 },
        timeout: 30_000,
      });
      const items = response.data?.items || [];
      setJobs(previous => {
        const knownIds = new Set(previous.map(job => job.jobId));
        return [...previous, ...items.filter(job => !knownIds.has(job.jobId))];
      });
      setNextCursor(response.data?.nextCursor || null);
    } catch (error) {
      alert(`Không thể tải thêm lịch sử: ${error.response?.data?.error || error.message}`);
    }
  };

  const handleDeleteJob = async (jobId, status) => {
    const isActive = ['pending', 'processing'].includes(status);
    const isConfirm = window.confirm(isActive
      ? 'Bạn có chắc chắn muốn hủy tiến trình đang dịch không?'
      : 'Bạn có chắc chắn muốn xóa tiến trình này không?');
    if (!isConfirm) return;

    try {
      await api.delete(`/jobs/${encodeURIComponent(jobId)}`, { timeout: 30_000 });
      setJobs(prevJobs => prevJobs.filter(job => job.jobId !== jobId));
    } catch (error) {
      alert('Lỗi khi xóa tiến trình: ' + (error.response?.data?.error || error.message));
    }
  };

  const handleBulkDeleteFolder = async (targetFolderName, folderJobs) => {
    const jobsToDelete = folderJobs.filter(job => job.status === 'completed' || job.status === 'failed');
    
    if (jobsToDelete.length === 0) {
      alert('Không có tài liệu nào hoàn thành hoặc lỗi để dọn dẹp.');
      return;
    }

    const isConfirm = window.confirm(`Bạn có chắc chắn muốn XÓA GỌN ${jobsToDelete.length} tiến trình (đã xong/lỗi) khỏi thư mục [${targetFolderName}]?`);
    if (!isConfirm) return;

    const jobIds = jobsToDelete.map(job => job.jobId);

    try {
      // Gửi 1 Request duy nhất lên API mới
      await api.post('/bulk-delete', { jobIds });
      
      // Dọn dẹp State UI nội bộ
      setJobs(prevJobs => prevJobs.filter(job => !jobIds.includes(job.jobId)));
    } catch (error) {
      alert('Lỗi khi dọn dẹp hàng loạt: ' + (error.response?.data?.error || error.message));
    }
  };

  // Khối logic xóa toàn bộ thư mục
  const handleDeleteEntireFolder = async (targetFolderName) => {
    const isConfirm = window.confirm(`🧨 CẢNH BÁO: Bạn có chắc chắn muốn XÓA GỐC toàn bộ thư mục [${targetFolderName}] không?\n\nHành động này sẽ hủy tất cả các file đang chờ dịch và dọn sạch dữ liệu.`);
    if (!isConfirm) return;

    try {
      // Dùng encodeURIComponent để an toàn với tên thư mục chứa dấu cách/kí tự đặc biệt
      await api.delete(`/folder/${encodeURIComponent(targetFolderName)}`);
      
      // Lọc bỏ toàn bộ job thuộc thư mục này ra khỏi State để UI cập nhật ngay lập tức
      setJobs(prevJobs => prevJobs.filter(job => (job.folderName || 'Mặc định') !== targetFolderName));
    } catch (error) {
      alert('Lỗi khi xóa toàn bộ thư mục: ' + (error.response?.data?.error || error.message));
    }
  };

  const handleForceWakeUp = async () => {
    const isConfirm = window.confirm('Bạn có chắc chắn muốn ép hệ thống thức dậy ngay lập tức không?');
    if (!isConfirm) return;

    try {
      await api.post('/force-wakeup');
      alert('🚀 Lệnh đánh thức đã được gửi thành công!');
      // State sysStatus sẽ tự động được cập nhật thông qua luồng SSE
    } catch (error) {
      alert('Lỗi: ' + (error.response?.data?.message || error.message));
    }
  };

  const handleFileChange = (e) => {
    setSelectedFiles(e.target.files); 
  };

  const sanitizeFileName = (name) => {
    // 1. Loại bỏ triệt để các chuỗi Mojibake phổ biến (như dấu nháy đơn lỗi) và ký tự thay thế Unicode
    let cleanName = name.replace(/â|â€™/g, '');
    
    // 2. Loại bỏ các ký tự cấm của Windows
    cleanName = cleanName.replace(/[<>:"/\\|?*]/g, '');
    cleanName = Array.from(cleanName)
      .filter(char => char.charCodeAt(0) >= 32)
      .join('');
    
    // 3. BỘ LỌC CỨNG: Chỉ giữ lại chữ cái (\p{L} - bao gồm tiếng Việt), số (\p{N}), khoảng trắng, gạch ngang, gạch dưới, ngoặc đơn
    cleanName = cleanName.replace(/[^\p{L}\p{N}\s\-_()]/gu, ''); 
    
    // 4. Chuẩn hóa khoảng trắng dư thừa thành dấu gạch dưới
    cleanName = cleanName.replace(/[\s\t\n]+/g, '_');
    
    // 5. Cắt bỏ dấu gạch dưới hoặc dấu chấm thừa ở 2 đầu tên file
    return cleanName.replace(/^[_.]+|[_.]+$/g, ''); 
  };

  const handleDownloadFolder = async (targetFolderName, folderJobs) => {
    const completedJobs = folderJobs.filter(job => job.status === 'completed');

    if (completedJobs.length === 0) {
      alert('Thư mục này chưa có tài liệu nào hoàn thành!');
      return;
    }

    if (!('showDirectoryPicker' in window)) {
      alert('⚠️ Trình duyệt của bạn không hỗ trợ File System Access API.');
      return;
    }

    try {
      const directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      let successCount = 0;
      let failedFiles = []; // [THÊM MỚI] Mảng theo dõi đích danh các file bị từ chối I/O
      const usedNames = new Map();

      for (const [index, job] of completedJobs.entries()) {
        try {
          let rawName = job.originalName || job.fileName || `TaiLieu_${index + 1}`;
          const baseName = rawName.replace(/\.[^/.]+$/, "");
          
          // Đưa qua màng lọc an toàn tuyệt đối
          const cleanName = sanitizeFileName(baseName);
          
          // Fallback: Lỡ tên file toàn ký tự rác bị lọc sạch trơn, thì dùng jobId thay thế
          const safeBaseName = cleanName || `Doc_${job.jobId}`;
          const collisionKey = safeBaseName.toLocaleLowerCase('vi-VN');
          const duplicateNumber = (usedNames.get(collisionKey) || 0) + 1;
          usedNames.set(collisionKey, duplicateNumber);
          const suffix = duplicateNumber > 1 ? `_${duplicateNumber}` : '';
          const finalFileName = `${safeBaseName}${suffix}_vi.md`;

          const fileHandle = await directoryHandle.getFileHandle(finalFileName, { create: true });
          const writable = await fileHandle.createWritable();
          try {
            const response = await fetch(
              `${API_BASE_URL}/jobs/${encodeURIComponent(job.jobId)}/download`
            );
            if (!response.ok || !response.body) {
              throw new Error(`Download thất bại với mã ${response.status}`);
            }

            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await writable.write(value);
            }
          } finally {
            await writable.close();
          }
          successCount++;
        } catch (fileError) {
          console.error(`Lỗi khi tải hoặc ghi file ${job.originalName}:`, fileError);
          // [THÊM MỚI] Đẩy tên file gốc bị lỗi vào mảng để báo cáo cho User
          failedFiles.push(job.originalName || job.fileName); 
        }
      }
      
      // [THÊM MỚI] Hiển thị báo cáo chi tiết
      if (failedFiles.length > 0) {
        alert(
          `✅ Đã lưu ${successCount}/${completedJobs.length} tài liệu.\n` + 
          `❌ Tải thất bại ${failedFiles.length} file:\n\n` + 
          failedFiles.map(f => `- ${f}`).join('\n') + 
          `\n\nVui lòng nhấn "Copy Markdown" thủ công cho các file bị lỗi tên này.`
        );
      } else {
        alert(`✅ Đã lưu thành công toàn bộ ${successCount}/${completedJobs.length} tài liệu của thư mục [${targetFolderName}]!`);
      }
    } catch (error) {
      if (error.name !== 'AbortError') console.error('❌ Lỗi System I/O:', error);
    }
  };  

  const groupedJobs = jobs.reduce((acc, job) => {
    const folder = job.folderName || 'Mặc định';
    if (!acc[folder]) acc[folder] = [];
    acc[folder].push(job);
    return acc;
  }, {});

  const dashboard = {
    uploadingBatches: localQueue.filter(task => !task.canCloseClient).length,
    uploadedBytes: localQueue.reduce((total, task) => total + (task.uploadedBytes || 0), 0),
    totalBytes: localQueue.reduce((total, task) => total + (task.totalBytes || 0), 0),
    confirmedFiles: localQueue.reduce((total, task) => total + (task.confirmedFiles || 0), 0),
    totalFiles: localQueue.reduce((total, task) => total + (task.totalFiles || 0), 0),
    safeFiles: localQueue.reduce((total, task) => total + (task.canCloseClient ? (task.confirmedFiles || 0) : 0), 0),
    pendingFiles: jobs.filter(job => job.status === 'pending').length,
    processingFiles: jobs.filter(job => job.status === 'processing').length,
    completedFiles: jobs.filter(job => job.status === 'completed').length,
    failedFiles: jobs.filter(job => job.status === 'failed').length,
  };

  return (
    <div className="app-container">
      <header className="header">
        <h1>🩺 StudyMed Translator</h1>
        <p>Hệ thống tự động dịch sách và tài liệu Y khoa (Multi-Batch Mode)</p>
        <span className={`connection-status ${sseConnected ? 'connected' : 'disconnected'}`}>
          {sseConnected ? '● Đã kết nối realtime' : '● Đang kết nối lại...'}
        </span>
        <span className={`storage-status ${sysStatus.storage?.available === true ? 'available' : sysStatus.storage?.available === false ? 'unavailable' : 'checking'}`} role="status">
          {sysStatus.storage?.available === true
            ? '☁ Cloud Storage sẵn sàng'
            : sysStatus.storage?.available === false ? '☁ Cloud Storage chưa sẵn sàng' : '☁ Đang kiểm tra Cloud Storage'}
          {sysStatus.storage?.cleanupBacklog > 0 && ` · ${sysStatus.storage.cleanupBacklog} file chờ dọn`}
        </span>
      </header>

      <main className="main-content">
        <section className="batch-dashboard" aria-label="Tổng quan tiến độ">
          <article>
            <strong>{dashboard.uploadingBatches}</strong>
            <span>Batch đang upload lên R2</span>
            <small>{formatMegabytes(dashboard.uploadedBytes)} / {formatMegabytes(dashboard.totalBytes)}</small>
          </article>
          <article>
            <strong>{dashboard.safeFiles}</strong>
            <span>File đã an toàn trên Cloud</span>
            <small>Đã xác nhận {dashboard.confirmedFiles}/{dashboard.totalFiles} file</small>
          </article>
          <article>
            <strong>{dashboard.pendingFiles + dashboard.processingFiles}</strong>
            <span>File Render đang dịch</span>
            <small>Chờ {dashboard.pendingFiles} · xử lý {dashboard.processingFiles} · xong {dashboard.completedFiles} · lỗi {dashboard.failedFiles}</small>
          </article>
        </section>
        
        {/* BANNER CẢNH BÁO NGỦ ĐÔNG HIỂN THỊ NỔI BẬT */}
        {sysStatus.isHibernating && sysStatus.stats && (
          <div className="hibernation-banner">
            <h3>🛑 Hệ Thống Đang Ngủ Đông (Circuit Breaker)</h3>
            <p>Hệ thống tạm dừng xử lý để bảo vệ API Quota.</p>
            <ul>
              <li><strong>Bắt đầu ngủ lúc:</strong> {new Date(sysStatus.stats.startTime).toLocaleTimeString('vi-VN')}</li>
              {/* HIỂN THỊ ĐÚNG MÚI GIỜ VIỆT NAM */}
              <li><strong>Dự kiến thức dậy tự động:</strong> {new Date(sysStatus.stats.wakeupTime).toLocaleTimeString('vi-VN')} ({sysStatus.stats.sleepHours} tiếng)</li>
              <li><strong>Số lần đã đánh thức nhưng vẫn thất bại:</strong> {sysStatus.stats.hibernationCount - 1} lần</li>
            </ul>

            {/* NÚT FORCE WAKE UP */}
            <button 
              onClick={handleForceWakeUp}
              style={{
                marginTop: '15px',
                padding: '8px 16px',
                backgroundColor: '#ffc107',
                color: '#000',
                border: 'none',
                borderRadius: '4px',
                fontWeight: 'bold',
                cursor: 'pointer'
              }}
            >
              ⚡ Ép hệ thống thức dậy ngay
            </button>
          </div>
        )}

        <div className="upload-section" style={{ display: 'flex', flexDirection: 'column', gap: '20px', background: '#ffffff', padding: '32px', borderRadius: '24px', boxShadow: '0 8px 30px rgba(0,0,0,0.06)', border: '1px solid #eaeaea', maxWidth: '850px', margin: '0 auto 40px auto' }}>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="sr-only" htmlFor="folderNameInput">Tên thư mục</label>
            <input 
              id="folderNameInput"
              type="text" 
              placeholder="📁 Tên thư mục (Vd: USMLE Step 1)" 
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              style={{ padding: '14px 18px', borderRadius: '12px', border: '1.5px solid #e0e0e0', flex: 1, minWidth: '250px', fontSize: '15px', outline: 'none', transition: 'border-color 0.2s', backgroundColor: '#fafafa', color: '#333' }}
              onFocus={(e) => { e.target.style.borderColor = '#007bff'; e.target.style.backgroundColor = '#fff'; }}
              onBlur={(e) => { e.target.style.borderColor = '#e0e0e0'; e.target.style.backgroundColor = '#fafafa'; }}
            />
            <div style={{ flex: 2, position: 'relative', minWidth: '300px' }}>
              <label className="sr-only" htmlFor="fileInput">Chọn các file PDF y khoa</label>
              <input 
                id="fileInput"
                type="file" 
                accept="application/pdf" 
                multiple 
                onChange={handleFileChange} 
                className="file-input"
                style={{ width: '100%', padding: '12px 15px', background: '#f0f4f8', border: '1.5px dashed #a0aec0', borderRadius: '12px', cursor: 'pointer', color: '#4a5568', transition: 'background 0.2s', fontSize: '14px' }}
                onMouseEnter={(e) => e.target.style.background = '#e2e8f0'}
                onMouseLeave={(e) => e.target.style.background = '#f0f4f8'}
              />
            </div>
          </div>
          
          <button 
            onClick={handleAddToQueue} 
            disabled={!selectedFiles || selectedFiles.length === 0 || Boolean(activeUploadTaskId)}
            className="upload-btn"
            style={{ padding: '14px 20px', borderRadius: '12px', fontSize: '16px', fontWeight: 'bold', background: (!selectedFiles || selectedFiles.length === 0) ? '#e9ecef' : '#007bff', color: (!selectedFiles || selectedFiles.length === 0) ? '#adb5bd' : '#ffffff', border: 'none', cursor: (!selectedFiles || selectedFiles.length === 0) ? 'not-allowed' : 'pointer', transition: 'all 0.2s ease', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', boxShadow: (!selectedFiles || selectedFiles.length === 0) ? 'none' : '0 4px 12px rgba(0, 123, 255, 0.3)' }}
          >
            <span style={{ fontSize: '1.2em' }}>☁️</span> Upload {selectedFiles ? selectedFiles.length : 0} file lên Cloud
          </button>

          {localQueue.some(task => task.canCloseClient) && (
            <div className="cloud-safe-banner" role="status">
              <strong>✅ Đã lưu an toàn trên Cloud — có thể tắt máy</strong>
              <span>Render sẽ tiếp tục dịch các tài liệu đã xác nhận, không cần giữ tab này mở.</span>
            </div>
          )}

          {localQueue.length > 0 && (
            <div className="cloud-queue">
              <h4>
                ☁️ Tiến độ lưu lên Cloud ({localQueue.filter(task => !task.canCloseClient).length} batch chưa an toàn)
              </h4>
              <ul>
                {localQueue.map(task => (
                  <li key={task.id} className={`cloud-task ${task.status}`}>
                    <div className="cloud-task-main">
                      <strong>📁 {task.folderName} <span>({task.totalFiles} files · {formatMegabytes(task.totalBytes)})</span></strong>
                      <span className="cloud-task-message">
                        {task.progressMsg}
                      </span>
                      <progress value={task.percent || 0} max="100" aria-label={`Tiến độ upload ${task.folderName}`} />
                      <small>
                        {formatMegabytes(task.uploadedBytes)} / {formatMegabytes(task.totalBytes)} · xác nhận {task.confirmedFiles || 0}/{task.totalFiles}
                      </small>
                    </div>
                    {task.status === 'error' && (
                      <div className="cloud-task-actions">
                        {task.entries?.length > 0 && (
                          <button onClick={() => handleRetryLocalTask(task.id)} disabled={Boolean(activeUploadTaskId)}>Thử lại</button>
                        )}
                        {task.failedItems?.length > 0 && (
                          <button onClick={() => handleAbandonFailedItems(task)}>Bỏ file lỗi</button>
                        )}
                      </div>
                    )}
                    {task.status === 'safe' && (
                      <button onClick={() => handleRemoveFromQueue(task.id)}>Ẩn</button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="jobs-container">
          {Object.entries(groupedJobs).map(([folderName, folderJobs]) => {
            const isCollapsed = collapsedFolders[folderName];
            return (
              <div key={folderName} className="folder-group" style={{ marginBottom: '40px', border: '1px solid #e0e0e0', borderRadius: '8px', padding: '15px', background: '#fcfcfc' }}>
                <div className="queue-header-actions" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #007bff', paddingBottom: '10px', marginBottom: '20px' }}>
                  <h3 
                    className="queue-title" 
                    onClick={() => toggleFolder(folderName)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') toggleFolder(folderName);
                    }}
                    role="button"
                    tabIndex={0}
                    aria-expanded={!isCollapsed}
                    style={{ color: '#007bff', margin: 0, cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}
                  >
                    <span style={{ fontSize: '0.7em', display: 'inline-block', transition: 'transform 0.2s ease', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                    📁 {folderName} ({folderJobs.length} files)
                  </h3>
                
                <div style={{ display: 'flex', gap: '10px' }}>
                  {/* Đã chỉnh sửa điều kiện hiển thị nút tải: Xóa && j.result */}
                  {folderJobs.some(j => j.status === 'completed') && (
                    <button onClick={() => handleDownloadFolder(folderName, folderJobs)} className="download-all-btn" style={{ background: '#28a745', color: 'white', border: 'none', padding: '8px 15px', borderRadius: '5px', cursor: 'pointer' }}>
                      📥 Tải các file đã xong
                    </button>
                  )}
                  {folderJobs.some(j => j.status === 'completed' || j.status === 'failed') && (
                    <button onClick={() => handleBulkDeleteFolder(folderName, folderJobs)} className="cleanup-btn" style={{ background: '#dc3545', color: 'white', border: 'none', padding: '8px 15px', borderRadius: '5px', cursor: 'pointer' }}>
                      🧹 Dọn dẹp
                    </button>
                  )}
                  
                  <button 
                    onClick={() => handleDeleteEntireFolder(folderName)} 
                    className="delete-folder-btn" 
                    style={{ background: '#850000', color: 'white', border: 'none', padding: '8px 15px', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}
                  >
                    🧨 Xóa toàn bộ hàng đợi
                  </button>
                </div>
              </div>
              
              {!isCollapsed && (
                <div className="masonry-grid-fallback">
                  {folderJobs.map(job => (
                    <JobCard key={job.jobId} job={job} onDelete={handleDeleteJob} />
                  ))}
                </div>
              )}
            </div>
            );
          })}

          {jobs.length === 0 && (
            <div className="empty-state">
              <div className="empty-wash">Chưa có tài liệu nào trong hệ thống.</div>
            </div>
          )}
          {nextCursor && (
            <button className="load-more-btn" onClick={handleLoadMoreJobs}>
              Tải thêm lịch sử
            </button>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
