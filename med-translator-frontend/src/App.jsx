import React, { useState, useEffect } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import './App.css';

// Ưu tiên đọc từ biến môi trường của Vercel/Vite, nếu không có sẽ tự động dùng máy chủ mặc định
const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://tranmed.onrender.com';

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
      const res = await axios.get(`${API_BASE_URL}/jobs/${job.jobId}/result`);
      setLocalResult(res.data.result);
      return res.data.result;
    } catch (err) {
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
    } catch (err) {
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
            {job.status === 'pending' && '⏳ Đang chờ...'}
            {job.status === 'processing' && '⚙️ Đang dịch...'}
            {job.status === 'completed' && '✅ Hoàn thành'}
            {job.status === 'failed' && '❌ Lỗi'}
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
          
          {(job.status === 'failed' || job.status === 'completed') && (
            <button 
              onClick={() => onDelete(job.jobId)} 
              className="delete-btn" 
              style={{ backgroundColor: '#dc3545', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', marginLeft: '8px', fontSize: '0.9em' }}
            >
              🗑️ Xóa
            </button>
          )}
        </div>
      </div>

      {job.status === 'failed' && (
        <div className="job-error">Chi tiết lỗi: {job.error}</div>
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

  // 1. Phục hồi trạng thái khi F5 (Bao gồm cả trạng thái Hệ thống và Jobs)
  useEffect(() => {
    const fetchInitialData = async () => {
      try {
        // Lấy trạng thái hệ thống
        const statusRes = await axios.get(`${API_BASE_URL}/status`);
        setSysStatus(statusRes.data);

      // Lấy danh sách Jobs
        const jobsRes = await axios.get(`${API_BASE_URL}/jobs`);
        
        // Cầu chì bảo vệ: Chặn trường hợp Render trả về trang HTML 502 thay vì JSON
        if (Array.isArray(jobsRes.data)) {
            const formattedJobs = jobsRes.data.map(j => ({ ...j, logs: [], result: null }));
            setJobs(formattedJobs);
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

  // 3. Lắng nghe SSE thời gian thực từ Backend
  useEffect(() => {
    const eventSource = new EventSource(`${API_BASE_URL}/stream`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // Lắng nghe sự kiện hệ thống ngủ đông / thức dậy
      if (data.type === 'systemStatus') {
        setSysStatus(data.data);
      }
      else if (data.type === 'status') {
        setJobs(prevJobs => prevJobs.map(job => 
          job.jobId === data.jobId ? { ...job, status: data.status, error: data.error } : job
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

      setIsProcessingQueue(true); // Khóa luồng

      // Cập nhật trạng thái UI là đang chạy
      setLocalQueue(prev => prev.map(t => 
        t.id === nextTask.id ? { ...t, status: 'uploading', progressMsg: '🚀 Bắt đầu nạp dữ liệu...' } : t
      ));

      const CHUNK_SIZE = 2; // Tối ưu chunk size
      const filesArray = nextTask.files;
      const totalFiles = filesArray.length;
      let uploadedCount = 0;

      try {
        for (let i = 0; i < totalFiles; i += CHUNK_SIZE) {
          const chunk = filesArray.slice(i, i + CHUNK_SIZE);
          const formData = new FormData();
          
          formData.append('folderName', nextTask.folderName);
          chunk.forEach(file => formData.append('files', file));

          const response = await axios.post(`${API_BASE_URL}`, formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
            onUploadProgress: (progressEvent) => {
              const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
              setLocalQueue(prev => prev.map(t => 
                t.id === nextTask.id ? { ...t, progressMsg: `Đang đẩy Lô ${Math.floor(i/CHUNK_SIZE) + 1}: ${percentCompleted}% (${uploadedCount}/${totalFiles})` } : t
              ));
            }
          });

          uploadedCount += chunk.length;
          setLocalQueue(prev => prev.map(t => 
            t.id === nextTask.id ? { ...t, progressMsg: `Đang đồng bộ DB: ${Math.min(uploadedCount, totalFiles)}/${totalFiles} files...` } : t
          ));

          const newJobs = response.data.jobs.map(j => ({ ...j, logs: [], result: null }));
          setJobs(prevJobs => {
            const existingIds = new Set(prevJobs.map(j => j.jobId));
            const uniqueNewJobs = newJobs.filter(j => !existingIds.has(j.jobId));
            return [...uniqueNewJobs, ...prevJobs]; 
          });
        }
        
        // Hoàn tất task
        setLocalQueue(prev => prev.map(t => 
          t.id === nextTask.id ? { ...t, status: 'completed', progressMsg: '✅ Đã đẩy lên Cloud' } : t
        ));

      } catch (error) {
        setLocalQueue(prev => prev.map(t => 
          t.id === nextTask.id ? { ...t, status: 'error', progressMsg: '❌ Lỗi Timeout / Mạng' } : t
        ));
      } finally {
        setIsProcessingQueue(false); // Mở khóa luồng cho task tiếp theo
      }
    };

    processQueue();
  }, [localQueue, isProcessingQueue]);

  // Thêm thao tác của người dùng vào Local Queue
  const handleAddToQueue = () => {
    if (!selectedFiles || selectedFiles.length === 0) return;

    const newTask = {
      id: Date.now(), // Unique ID cho mỗi task tải lên
      folderName: folderName.trim() || 'Mặc định',
      files: Array.from(selectedFiles),
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
    setLocalQueue(prev => prev.filter(task => task.id !== taskId));
  };

  const handleDeleteJob = async (jobId) => {
    const isConfirm = window.confirm('Bạn có chắc chắn muốn xóa tiến trình này không?');
    if (!isConfirm) return;

    try {
      await axios.delete(`${API_BASE_URL}/jobs/${jobId}`);
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
      await axios.post(`${API_BASE_URL}/bulk-delete`, { jobIds });
      
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
      await axios.delete(`${API_BASE_URL}/folder/${encodeURIComponent(targetFolderName)}`);
      
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
      await axios.post(`${API_BASE_URL}/force-wakeup`);
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
    cleanName = cleanName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '');
    
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

      for (const [index, job] of completedJobs.entries()) {
        try {
          const resultRes = await axios.get(`${API_BASE_URL}/jobs/${job.jobId}/result`);
          const markdownContent = resultRes.data.result;

          if (!markdownContent) continue;

          let rawName = job.originalName || job.fileName || `TaiLieu_${index + 1}`;
          const baseName = rawName.replace(/\.[^/.]+$/, "");
          
          // Đưa qua màng lọc an toàn tuyệt đối
          const cleanName = sanitizeFileName(baseName);
          
          // Fallback: Lỡ tên file toàn ký tự rác bị lọc sạch trơn, thì dùng jobId thay thế
          const finalFileName = `${cleanName || `Doc_${job.jobId}`}_vi.md`;

          const fileHandle = await directoryHandle.getFileHandle(finalFileName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(markdownContent);
          await writable.close();
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

        <div className="upload-section" style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <input 
              type="text" 
              placeholder="Tên thư mục (Vd: USMLE Step 1)" 
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc', flex: 1 }}
            />
            <input 
              id="fileInput"
              type="file" 
              accept="application/pdf" 
              multiple 
              onChange={handleFileChange} 
              className="file-input"
              style={{ flex: 2 }}
            />
          </div>
          
          <button 
            onClick={handleAddToQueue} 
            disabled={!selectedFiles || selectedFiles.length === 0}
            className="upload-btn"
          >
            ➕ Thêm {selectedFiles ? selectedFiles.length : 0} file vào Local Queue
          </button>

          {/* HIỂN THỊ DANH SÁCH LOCAL QUEUE */}
          {localQueue.length > 0 && (
            <div style={{ marginTop: '10px', background: '#f8f9fa', border: '1px solid #dee2e6', borderRadius: '6px', padding: '10px' }}>
              <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#495057' }}>Hàng chờ thiết bị ({localQueue.filter(t => t.status !== 'completed').length} đang đợi)</h4>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {localQueue.map(task => (
                  <li key={task.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', background: '#fff', padding: '8px', border: '1px solid #eee', borderRadius: '4px' }}>
                    <div>
                      <strong>📁 {task.folderName}</strong> ({task.files.length} files) 
                      <span style={{ marginLeft: '10px', color: task.status === 'error' ? 'red' : task.status === 'completed' ? 'green' : '#007bff' }}>
                        {task.progressMsg}
                      </span>
                    </div>
                    {task.status === 'pending' && (
                      <button onClick={() => handleRemoveFromQueue(task.id)} style={{ background: 'none', border: 'none', color: '#dc3545', cursor: 'pointer', fontWeight: 'bold' }}>✕ Xóa</button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="jobs-container">
          {Object.entries(groupedJobs).map(([folderName, folderJobs]) => (
            <div key={folderName} className="folder-group" style={{ marginBottom: '40px', border: '1px solid #e0e0e0', borderRadius: '8px', padding: '15px', background: '#fcfcfc' }}>
              <div className="queue-header-actions" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #007bff', paddingBottom: '10px', marginBottom: '20px' }}>
                <h3 className="queue-title" style={{ color: '#007bff', margin: 0 }}>
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
              
              <div className="masonry-grid-fallback">
                {folderJobs.map(job => (
                  <JobCard key={job.jobId} job={job} onDelete={handleDeleteJob} />
                ))}
              </div>
            </div>
          ))}

          {jobs.length === 0 && (
            <div className="empty-state">
              <div className="empty-wash">Chưa có tài liệu nào trong hệ thống.</div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;