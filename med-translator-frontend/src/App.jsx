import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import './App.css';
import api, { API_BASE_URL } from './api/client.js';

const LOCAL_QUEUE_KEEP_ALIVE_MS = 5 * 60 * 1000;

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
  
  // KHAI BÁO STATE CHO LOCAL QUEUE
  const [localQueue, setLocalQueue] = useState([]); // Array chứa các thư mục chờ đẩy lên
  const [isProcessingQueue, setIsProcessingQueue] = useState(false); // Cờ khóa luồng
  
  const [jobs, setJobs] = useState([]); 
  const [sysStatus, setSysStatus] = useState({ isHibernating: false, stats: null });
  const [collapsedFolders, setCollapsedFolders] = useState({});
  const [feederTick, setFeederTick] = useState(0);
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
      } catch (error) {
        console.error("Lỗi khởi tạo dữ liệu:", error);
        alert("⚠️ Không thể tải danh sách tài liệu từ Cloud. Máy chủ đang khởi động hoặc quá tải do phục hồi dữ liệu. Vui lòng nhấn F5 (Tải lại trang) sau 30 giây.");
      }
    };
    fetchInitialData();
  }, []);

  useEffect(() => {
    const hasLocalWork = localQueue.some(task => ['pending', 'uploading'].includes(task.status));
    if (!hasLocalWork) return undefined;

    const interval = setInterval(() => setFeederTick(value => value + 1), 5000);
    // Render Free spin down nếu 15 phút không có request HTTP mới. SSE heartbeat chỉ đi
    // từ server ra trình duyệt, vì vậy dùng một request nhẹ khi Local Queue còn công việc.
    const keepAliveInterval = setInterval(() => {
      api.get('/status', { timeout: 30_000 }).catch(error => {
        console.error('Không thể giữ Render thức khi Local Queue đang chạy:', error);
      });
    }, LOCAL_QUEUE_KEEP_ALIVE_MS);
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);

    return () => {
      clearInterval(interval);
      clearInterval(keepAliveInterval);
      window.removeEventListener('beforeunload', warnBeforeUnload);
    };
  }, [localQueue]);

  // 3. Lắng nghe SSE thời gian thực từ Backend
  useEffect(() => {
    const eventSource = new EventSource(`${API_BASE_URL}/stream`);

    const resync = async () => {
      try {
        const [statusRes, jobsRes] = await Promise.all([
          api.get('/status', { timeout: 30_000 }),
          api.get('/jobs', { timeout: 30_000 }),
        ]);
        setSysStatus(statusRes.data);
        const jobItems = Array.isArray(jobsRes.data) ? jobsRes.data : jobsRes.data?.items;
        if (Array.isArray(jobItems)) {
          setJobs(jobItems.map(job => ({ ...job, logs: [], result: null })));
          setNextCursor(Array.isArray(jobsRes.data) ? null : jobsRes.data.nextCursor);
        }
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
        setSysStatus(data.data);
      }
      else if (data.type === 'status') {
        setJobs(prevJobs => prevJobs.map(job => 
          job.jobId === data.jobId ? { ...job, ...data } : job
        ));
      } 
    };

    return () => eventSource.close();
  }, []); 

  // BACKGROUND WORKER (Tự động chạy ngầm tải lên tuần tự)
  useEffect(() => {
    const processQueue = async () => {
      // Bỏ qua nếu đang xử lý 1 task khác hoặc hàng đợi không có pending task
      if (isProcessingQueue) return;
      const nextTask = localQueue.find(task => task.status === 'pending');
      if (!nextTask) return;

      if (nextTask.currentJobId) {
        const currentServerJob = jobs.find(job => job.jobId === nextTask.currentJobId);
        if (!currentServerJob) return;

        if (['pending', 'processing'].includes(currentServerJob.status)) return;

        if (currentServerJob.status === 'completed') {
          setLocalQueue(previous => previous.map(task => task.id === nextTask.id
            ? {
                ...task,
                currentJobId: null,
                progressMsg: `✅ Server đã hoàn thành ${task.nextFileIndex}/${task.totalFiles} file...`
              }
            : task));
          return;
        }

        const retryIndex = Math.max(0, nextTask.nextFileIndex - 1);
        if (currentServerJob.status === 'failed' && currentServerJob.errorCode === 'FILE_MISSING') {
          setLocalQueue(previous => previous.map(task => task.id === nextTask.id
            ? {
                ...task,
                status: 'pending',
                nextFileIndex: retryIndex,
                currentJobId: null,
                progressMsg: '♻️ Render đã mất file tạm; đang tải lại đúng file từ thiết bị...'
              }
            : task));
          return;
        }

        setLocalQueue(previous => previous.map(task => task.id === nextTask.id
          ? {
              ...task,
              status: 'error',
              nextFileIndex: retryIndex,
              currentJobId: null,
              uploadIds: task.uploadIds.map((id, index) => index === retryIndex ? crypto.randomUUID() : id),
              progressMsg: `❌ ${currentServerJob.error || 'Server không thể xử lý file hiện tại.'}`
            }
          : task));
        return;
      }

      setIsProcessingQueue(true); // Khóa luồng

      // Cập nhật trạng thái UI là đang chạy
      setLocalQueue(prev => prev.map(t => 
        t.id === nextTask.id ? { ...t, status: 'uploading', progressMsg: '🚀 Bắt đầu nạp dữ liệu...' } : t
      ));

      const filesArray = nextTask.files;
      const totalFiles = filesArray.length;

      try {
        const capacityRes = await api.get('/capacity', { timeout: 15_000 });
        if (!capacityRes.data.canAcceptUpload) {
          setLocalQueue(prev => prev.map(task => task.id === nextTask.id
            ? { ...task, status: 'pending', progressMsg: `⏸️ Server đang bận, giữ ${totalFiles - task.nextFileIndex} file trên thiết bị...` }
            : task));
          return;
        }

        if (nextTask.nextFileIndex >= totalFiles) {
          setLocalQueue(prev => prev.map(task => task.id === nextTask.id
            ? { ...task, status: 'completed', files: [], progressMsg: `✅ Đã xử lý xong ${totalFiles}/${totalFiles} file` }
            : task));
          return;
        }

        const currentIndex = nextTask.nextFileIndex;
        const file = filesArray[currentIndex];
        if (file.size > capacityRes.data.maxFileSizeBytes) {
          setLocalQueue(prev => prev.map(task => task.id === nextTask.id
            ? {
                ...task,
                status: 'error',
                progressMsg: `❌ ${file.name} vượt giới hạn ${Math.round(capacityRes.data.maxFileSizeBytes / 1024 / 1024)} MB`
              }
            : task));
          return;
        }
        const formData = new FormData();
        formData.append('folderName', nextTask.folderName);
        formData.append('clientUploadId', nextTask.uploadIds[currentIndex]);
        formData.append('files', file);

        const response = await api.post('/', formData, {
          timeout: 15 * 60_000,
          onUploadProgress: (progressEvent) => {
            const total = progressEvent.total || file.size || 1;
            const percentCompleted = Math.round((progressEvent.loaded * 100) / total);
            setLocalQueue(prev => prev.map(task => task.id === nextTask.id
              ? { ...task, progressMsg: `⬆️ Đang tải ${currentIndex + 1}/${totalFiles}: ${percentCompleted}%` }
              : task));
          }
        });

        const newJobs = response.data.jobs.map(job => ({ ...job, logs: [], result: null }));
        setJobs(prevJobs => {
          const existingIds = new Set(prevJobs.map(job => job.jobId));
          return [...newJobs.filter(job => !existingIds.has(job.jobId)), ...prevJobs];
        });

        setLocalQueue(prev => prev.map(t => 
          t.id === nextTask.id ? {
            ...t,
            status: 'pending',
            nextFileIndex: currentIndex + 1,
            currentJobId: newJobs[0]?.jobId || null,
            progressMsg: `☁️ Đã giao ${currentIndex + 1}/${totalFiles} file; chờ server dịch xong...`
          } : t
        ));

      } catch (error) {
        const isServerBusy = [409, 507].includes(error.response?.status);
        setLocalQueue(prev => prev.map(t => 
          t.id === nextTask.id ? {
            ...t,
            status: isServerBusy ? 'pending' : 'error',
            progressMsg: isServerBusy
              ? '⏸️ Server chưa đủ dung lượng, sẽ tự thử lại...'
              : `❌ Upload lỗi: ${error.response?.data?.error || error.message}`
          } : t
        ));
      } finally {
        setIsProcessingQueue(false); // Mở khóa luồng cho task tiếp theo
      }
    };

    processQueue();
  }, [localQueue, isProcessingQueue, feederTick, jobs]);

  // Thêm thao tác của người dùng vào Local Queue
  const handleAddToQueue = () => {
    if (!selectedFiles || selectedFiles.length === 0) return;

    const newTask = {
      id: Date.now(), // Unique ID cho mỗi task tải lên
      folderName: folderName.trim() || 'Mặc định',
      files: Array.from(selectedFiles),
      uploadIds: Array.from(selectedFiles, () => crypto.randomUUID()),
      totalFiles: selectedFiles.length,
      nextFileIndex: 0,
      currentJobId: null,
      status: 'pending', // pending, uploading, completed, error
      progressMsg: '⏳ Đang xếp hàng chờ tải lên...'
    };

    setLocalQueue(prev => [...prev, newTask]);
    
    // Reset Form Input ngay lập tức để người dùng có thể chọn tiếp
    document.getElementById('fileInput').value = '';
    setSelectedFiles(null);
    setFolderName('');
  };

  // NÚT XÓA TASK KHỎI HÀNG CHỜ KHI CHƯA CHẠY
  const handleRemoveFromQueue = (taskId) => {
    setLocalQueue(prev => prev.filter(task => task.id !== taskId || task.status === 'uploading'));
  };

  const handleRetryLocalTask = (taskId) => {
    setLocalQueue(prev => prev.map(task => task.id === taskId
      ? { ...task, status: 'pending', progressMsg: '🔄 Đang thử upload lại...' }
      : task));
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

  return (
    <div className="app-container">
      <header className="header">
        <h1>🩺 StudyMed Translator</h1>
        <p>Hệ thống tự động dịch sách và tài liệu Y khoa (Multi-Batch Mode)</p>
        <span className={`connection-status ${sseConnected ? 'connected' : 'disconnected'}`}>
          {sseConnected ? '● Đã kết nối realtime' : '● Đang kết nối lại...'}
        </span>
      </header>

      <main className="main-content">
        
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
            disabled={!selectedFiles || selectedFiles.length === 0}
            className="upload-btn"
            style={{ padding: '14px 20px', borderRadius: '12px', fontSize: '16px', fontWeight: 'bold', background: (!selectedFiles || selectedFiles.length === 0) ? '#e9ecef' : '#007bff', color: (!selectedFiles || selectedFiles.length === 0) ? '#adb5bd' : '#ffffff', border: 'none', cursor: (!selectedFiles || selectedFiles.length === 0) ? 'not-allowed' : 'pointer', transition: 'all 0.2s ease', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', boxShadow: (!selectedFiles || selectedFiles.length === 0) ? 'none' : '0 4px 12px rgba(0, 123, 255, 0.3)' }}
          >
            <span style={{ fontSize: '1.2em' }}>➕</span> Thêm {selectedFiles ? selectedFiles.length : 0} file vào Local Queue
          </button>

          {/* HIỂN THỊ DANH SÁCH LOCAL QUEUE */}
          {localQueue.length > 0 && (
            <div style={{ marginTop: '10px', background: '#f8f9fa', border: '1px solid #dee2e6', borderRadius: '12px', padding: '16px' }}>
              <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#495057', display: 'flex', alignItems: 'center', gap: '6px' }}>
                ⏳ Hàng chờ thiết bị ({localQueue.filter(t => t.status !== 'completed').length} đang đợi)
              </h4>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {localQueue.map(task => (
                  <li key={task.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13.5px', background: '#fff', padding: '12px 16px', border: '1px solid #eaeaea', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.02)' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <strong>📁 {task.folderName} <span style={{fontWeight: 'normal', color: '#6c757d', fontSize: '0.9em'}}>({task.totalFiles} files)</span></strong>
                      <span style={{ fontSize: '12.5px', color: task.status === 'error' ? '#dc3545' : task.status === 'completed' ? '#28a745' : '#007bff', fontWeight: '500' }}>
                        {task.progressMsg}
                      </span>
                    </div>
                    {task.status === 'pending' && task.nextFileIndex === 0 && (
                      <button onClick={() => handleRemoveFromQueue(task.id)} style={{ background: '#ffebee', border: 'none', color: '#dc3545', cursor: 'pointer', fontWeight: 'bold', padding: '6px 12px', borderRadius: '6px', transition: 'background 0.2s' }} onMouseEnter={(e) => e.target.style.background = '#ffcdd2'} onMouseLeave={(e) => e.target.style.background = '#ffebee'}>✕ Xóa</button>
                    )}
                    {task.status === 'error' && (
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button onClick={() => handleRetryLocalTask(task.id)}>Thử lại</button>
                        <button onClick={() => handleRemoveFromQueue(task.id)}>Xóa</button>
                      </div>
                    )}
                    {task.status === 'completed' && (
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
