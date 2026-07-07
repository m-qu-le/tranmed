## Quy trình Chuẩn hóa và Xử lý Linh hoạt cho AI Coding Agent

Tài liệu này được thiết kế để AI Agent đọc, hiểu và tự động áp dụng cấu hình Git/SSH phù hợp khi làm việc với các dự án khác nhau trên cùng một thiết bị Windows. Quy trình này loại bỏ hoàn toàn rủi ro xung đột quyền hoặc commit nhầm danh tính.

## 1. MA TRẬN TÀI KHOẢN (ACCOUNT MATRIX)

Khi nhận diện một dự án, AI Agent phải xác định dự án đó thuộc phân hệ nào dưới đây để áp dụng đúng cấu hình:

|Phân hệ (Context)|Email Đăng Ký GitHub|Tên SSH Host Quy Định|Đường Dẫn Khóa SSH Private Key|
|---|---|---|---|
|**Cá nhân (Personal)**|`lequang2k5012345@gmail.com`|`github.com-personal`|`C:\Users\lequa\.ssh\id_ed25519_personal`|
|**Công việc (Work)**|`mqule.md.hmu@gmail.com`|`github.com-work`|`C:\Users\lequa\.ssh\id_ed25519_work`|

## 3. QUY TRÌNH XỬ LÝ KHI GẶP MỘT DỰ ÁN MỚI (PROJECT-LEVEL WORKFLOW)

Mỗi khi khởi tạo, tiếp nhận, hoặc thực hiện lệnh push cho một thư mục dự án mới, AI Agent **bắt buộc** phải thực thi thuật toán phân loại và cấu hình theo các bước sau:

### Bước 3.1: Xác định ngữ cảnh dự án (Determine Context)

AI Agent cần phải hỏi lại người dùng để xác định chính xác dự án này là dự án cá nhân hay công việc. Không tự ý đoán mò để tránh push nhầm. 

### Bước 3.2: Thiết lập thông tin tác giả cục bộ (Local Git Config)

Di chuyển vào thư mục gốc của dự án (`cd <project-dir>`) và chạy lệnh cấu hình cục bộ. **Tuyệt đối không dùng cờ `--global`**.

- **Nếu là dự án Cá nhân:**
    
    ```
    git config --local user.name "Quang Le"
    git config --local user.email "lequang2k5012345@gmail.com"
    ```
    
- **Nếu là dự án Công việc:**
    
    ```
    git config --local user.name "Quang Le"
    git config --local user.email "mqule.md.hmu@gmail.com"
    ```
    

### Bước 3.3: Định hình lại URL của Remote Repository (Remote URL Routing)

Để Git sử dụng đúng cặp khóa SSH đã cấu hình tại file `config`, URL của remote `origin` phải được thay đổi từ tên miền tiêu chuẩn sang tên Host tùy chỉnh.

- **Trường hợp 1: Dự án được Clone mới từ đầu** Thay vì `git clone git@github.com:Username/RepoName.git`, hãy thực hiện:
    
    ```
    # Dự án Cá nhân
    git clone git@github.com-personal:Username/RepoName.git
    
    # Dự án Công việc
    git clone git@github.com-work:Username/RepoName.git
    ```
    
- **Trường hợp 2: Dự án đã tồn tại sẵn cục bộ hoặc khởi tạo qua `git init`** Chạy lệnh cập nhật hoặc thêm remote:
    
    ```
    # Dự án Cá nhân
    git remote set-url origin git@github.com-personal:Username/RepoName.git
    
    # Dự án Công việc
    git remote set-url origin git@github.com-work:Username/RepoName.git
    ```
    

## 4. CÁC LỖI THƯỜNG GẶP, THUẬT TOÁN PHÁT HIỆN VÀ CÁCH KHẮC PHỤC

### Lỗi 1: Lỗi phân quyền truy cập (`Permission denied (publickey)`)

- **Dấu hiệu nhận biết:** Khi thực hiện `git push` hoặc `git fetch`, terminal trả về lỗi: `Permission to Username/RepoName.git denied to wrong_user. fatal: Could not read from remote repository.`
    
- **Nguyên nhân:** AI Agent chưa cấu hình lại Remote URL (vẫn đang để `github.com` mặc định), dẫn đến việc hệ thống tự động bốc khóa SSH mặc định hoặc sai khóa để xác thực.
    
- **Cách khắc phục cho AI Agent:**
    
    1. Kiểm tra URL remote hiện tại: `git remote -v`
        
    2. Nếu URL hiển thị dạng `git@github.com:...`, hãy chạy lại lệnh sửa đổi URL tương ứng với phân hệ dự án: `git remote set-url origin git@github.com-<personal|work>:Username/RepoName.git`
        
    3. Thử lại lệnh push.
        

### Lỗi 2: Sai lệch thông tin tác giả trong lịch sử Commit (Wrong Author Avatar/Email)

- **Dấu hiệu nhận biết:** Lệnh push thành công, nhưng trên giao diện web của GitHub, commit hiển thị avatar của tài khoản cá nhân trong repository công việc (hoặc ngược lại).
    
- **Nguyên nhân:** AI Agent quên chạy lệnh `git config --local user.email` trong thư mục dự án, khiến Git sử dụng cấu hình toàn cục (`--global`).
    
- **Cách khắc phục cho AI Agent:**
    
    1. Kiểm tra email đang áp dụng cho thư mục hiện hành: `git config user.email`
        
    2. Sửa đổi lại đúng email cục bộ: `git config --local user.email "email_chinh_xac@gmail.com"`
        
    3. _Mẹo sửa đổi commit cuối cùng bị sai (nếu chưa push rộng rãi):_ Chạy `git commit --amend --reset-author --no-edit` để cập nhật lại thông tin tác giả cho commit gần nhất theo cấu hình mới vừa sửa.
        

### Lỗi 3: Xung đột HTTPS và đòi nhập Token (Credential Helper Prompt)

- **Dấu hiệu nhận biết:** Git liên tục yêu cầu nhập Username/Password hoặc Personal Access Token (PAT) bằng một hộp thoại Windows khi thực hiện push.
    
- **Nguyên nhân:** URL của dự án đang ở dạng HTTPS (`https://github.com/...`) chứ không phải SSH (`git@github.com...`). Giao thức HTTPS không thể áp dụng cơ chế định tuyến qua file SSH `config`.
    
- **Cách khắc phục cho AI Agent:** Chuyển đổi giao thức của remote URL từ HTTPS sang SSH tùy chỉnh:
    
    ```
    # Chuyển đổi sang SSH định tuyến cá nhân
    git remote set-url origin git@github.com-personal:Username/RepoName.git
    
    # Hoặc sang SSH định tuyến công việc
    git remote set-url origin git@github.com-work:Username/RepoName.git
    ```
    

## 5. BẢN KIỂM TRA ĐIỀU KIỆN (CHECKLIST) TRƯỚC KHI THỰC HIỆN COMMIT & PUSH

Trước khi thực hiện bất kỳ lệnh thay đổi mã nguồn nào, AI Agent nên tự động chạy các dòng lệnh kiểm tra sau để đảm bảo an toàn tuyệt đối:

```
# 1. Kiểm tra xem email cấu hình cục bộ đã đúng với tài khoản đích chưa
git config --local user.email

# 2. Kiểm tra xem URL remote đã được định tuyến qua Host tùy chỉnh chưa
git remote -v
```

Nếu cả hai kết quả trùng khớp với **Ma trận tài khoản** tại Mục 1, AI Agent có thể tiến hành xử lý mã nguồn và thực hiện tương tác với kho lưu trữ GitHub một cách an toàn.