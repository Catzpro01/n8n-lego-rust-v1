use n8n_runtime_kernel::{KernelScheduler, SchedulerOptions};

#[tokio::test]
async fn test_kernel_scheduler_new_with_durable_wal_invalid_path_fails_closed() {
    // Attempting to initialize durable WAL on a path where a directory already exists as the file
    let temp_dir = std::env::temp_dir().join(format!("test_wal_dir_collision_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();

    // Passing the directory itself as the WAL file path causes an IO error when opening as a file
    let res = KernelScheduler::new_with_durable_wal(SchedulerOptions::default(), &temp_dir).await;
    assert!(
        res.is_err(),
        "KernelScheduler must return an Err when WAL storage cannot be initialized"
    );

    // Clean up
    std::fs::remove_dir_all(&temp_dir).ok();
}

#[tokio::test]
async fn test_durable_wal_refuses_silent_downgrade() {
    // Create a regular file, then attempt to create a directory under it
    let temp_file = std::env::temp_dir().join(format!("test_wal_not_a_dir_{}", uuid::Uuid::new_v4()));
    std::fs::write(&temp_file, b"i am a file").unwrap();

    let invalid_nested_wal = temp_file.join("sub_folder").join("execution.wal");
    let res = KernelScheduler::new_with_durable_wal(SchedulerOptions::default(), &invalid_nested_wal).await;
    assert!(
        res.is_err(),
        "Durable WAL initialization on non-directory parent path must fail closed"
    );

    // Clean up
    std::fs::remove_file(&temp_file).ok();
}

#[tokio::test]
async fn test_durable_wal_success_preserves_durability_contract() {
    let temp_dir = std::env::temp_dir().join(format!("test_wal_valid_{}", uuid::Uuid::new_v4()));
    let wal_file = temp_dir.join("execution.wal");

    let res = KernelScheduler::new_with_durable_wal(SchedulerOptions::default(), &wal_file).await;
    assert!(res.is_ok(), "Valid WAL path must successfully create scheduler with durable journal");

    // Clean up
    std::fs::remove_dir_all(&temp_dir).ok();
}
